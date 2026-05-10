import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as util from 'node:util';
import { randomUUID } from 'node:crypto';
import * as mime from 'mime-types';
import pLimit = require('p-limit');
import CachePolicy = require('http-cache-semantics');

const NO_PROXY_HEADERS = ['date', 'server', 'host'];
const CACHE_METHODS = ['GET', 'HEAD'];
const DEFAULT_REGEX = /\.(png|jpg|jpeg|css|html|js|tar|tgz|tar\.gz)$/;
const DEFAULT_MAX_CONCURRENCY = 10;

type LogFn = (format: string, ...args: unknown[]) => void;

export interface FsCachingServerOptions {
  host: string;
  port: number;
  backendUrl: string;
  cacheDir: string;
  regex?: RegExp;
  noProxyHeaders?: string[];
  cacheMethods?: string[];
  maxConcurrency?: number;
}

interface QueuedRequest {
  id: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

export class FsCachingServer extends EventEmitter {
  readonly host: string;
  readonly port: number;
  readonly backendUrl: string;
  readonly cacheDir: string;
  readonly regex: RegExp;
  readonly noProxyHeaders: string[];
  readonly cacheMethods: string[];
  readonly backendHttps: boolean;
  readonly maxConcurrency: number;

  private server: http.Server | null = null;
  private readonly _limit: pLimit.Limit;
  idle = true;
  private inProgress: Record<string, QueuedRequest[]> = {};

  constructor(opts: FsCachingServerOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port;
    this.backendUrl = opts.backendUrl;
    this.cacheDir = opts.cacheDir;
    this.regex = opts.regex ?? DEFAULT_REGEX;
    this.noProxyHeaders = opts.noProxyHeaders ?? [...NO_PROXY_HEADERS];
    this.cacheMethods = opts.cacheMethods ?? [...CACHE_METHODS];
    this.backendHttps = this.backendUrl.startsWith('https:');
    this.maxConcurrency = opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this._limit = pLimit(this.maxConcurrency);
  }

  start(): void {
    if (this.server) throw new Error('server already exists');

    this._log('starting server');
    this.inProgress = {};
    this.idle = true;
    this.server = http.createServer((req, res) => this._onRequest(req, res));
    this.server.listen(this.port, this.host, () => {
      this._log('listening on http://%s:%d', this.host, this.port);
      this._log('proxying requests to %s', this.backendUrl);
      this._log('caching matches of %s', this.regex);
      this._log('caching to %s', this.cacheDir);
      this._log('max concurrent backend fetches: %d', this.maxConcurrency);
      this.emit('start');
    });
  }

  stop(): void {
    if (!this.server) throw new Error('server does not exist');
    this.server.once('close', () => {
      this.idle = true;
      this.server = null;
      this.emit('stop');
    });
    this.server.close();
  }

  onIdle(cb: () => void): void {
    if (this.idle) {
      cb();
    } else {
      this.once('idle', cb);
    }
  }

  private _onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const id = randomUUID();

    const log: LogFn = (format, ...args) => {
      this._log('[%s] %s', id, util.format(format, ...args));
    };

    logAccess(req, res, (s) => {
      this.emit('access-log', s);
      log(s);
    });

    log('INCOMING REQUEST - %s %s', req.method, req.url);

    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');

    // Defined early so it can be used before or after the caching path.
    const proxyDirect = (): void => {
      log('request will be proxied with no caching');

      const backendPath = parsedUrl.pathname + parsedUrl.search;
      const uristring = this.backendUrl + backendPath;
      const parsedBackend = new URL(uristring);
      const headers = buildProxyHeaders(req.headers, this.noProxyHeaders);
      headers['host'] = parsedBackend.host;

      const oreq = this._makeRequest(
        {
          hostname: parsedBackend.hostname,
          port: parsedBackend.port || undefined,
          path: parsedBackend.pathname + parsedBackend.search,
          method: req.method ?? 'GET',
          headers,
        },
        (ores) => {
          res.statusCode = ores.statusCode ?? 500;
          copyHeaders(ores.headers, res, this.noProxyHeaders);
          ores.pipe(res);
        },
      );

      oreq.once('error', () => {
        res.statusCode = 500;
        res.end();
      });

      req.pipe(oreq);
    };

    let file!: string;
    try {
      file = path.posix.normalize(decodeURIComponent(parsedUrl.pathname));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('failed to parse pathname - sending 400 to client - %s', msg);
      res.statusCode = 400;
      res.end();
      return;
    }

    if (!this.cacheMethods.includes(req.method ?? '') || !this.regex.test(file)) {
      proxyDirect();
      return;
    }

    file = path.join(this.cacheDir, file);

    const checkIdle = (): void => {
      if (Object.keys(this.inProgress).length === 0) {
        this.idle = true;
        this.emit('idle');
      }
    };

    const finish = (opts: { statusCode?: number; ores?: http.IncomingMessage }): void => {
      if (opts.statusCode !== undefined) {
        for (const o of this.inProgress[file]) {
          o.res.statusCode = opts.statusCode;
          o.res.end();
        }
        delete this.inProgress[file];
        checkIdle();
        return;
      }

      const ores = opts.ores!;
      fs.stat(file, (_err, stats) => {
        if (stats?.isDirectory()) {
          for (const o of this.inProgress[file]) {
            o.res.statusCode = 400;
            o.res.end();
          }
        } else if (stats) {
          for (const o of this.inProgress[file]) {
            o.res.statusCode = ores.statusCode ?? 500;
            copyHeaders(ores.headers, o.res, this.noProxyHeaders);
            streamFile(file, stats, o.req, o.res);
          }
        } else {
          for (const o of this.inProgress[file]) {
            o.res.statusCode = 500;
            o.res.end();
          }
        }
        delete this.inProgress[file];
        checkIdle();
      });
    };

    fs.stat(file, (_err, stats) => {
      if (stats?.isDirectory()) {
        log('%s is a directory - sending 400 to client', file);
        res.statusCode = 400;
        res.end();
        return;
      }

      if (stats) {
        log('%s is a file (cached) - streaming to client', file);
        streamFile(file, stats, req, res);
        return;
      }

      if (Object.hasOwn(this.inProgress, file)) {
        log('%s download in progress - response queued', file);
        this.inProgress[file].push({ id, req, res });
        return;
      }

      if (req.method === 'HEAD') {
        proxyDirect();
        return;
      }

      this.inProgress[file] = [];
      this.idle = false;

      const backendPath = parsedUrl.pathname + parsedUrl.search;
      const uristring = this.backendUrl + backendPath;
      const parsedBackend = new URL(uristring);
      const headers = buildProxyHeaders(req.headers, this.noProxyHeaders);
      headers['host'] = parsedBackend.host;

      log('proxying %s to %s', req.method, uristring);

      void this._limit(
        () =>
          new Promise<void>((resolve) => {
            const oreq = this._makeRequest(
              {
                hostname: parsedBackend.hostname,
                port: parsedBackend.port || undefined,
                path: parsedBackend.pathname + parsedBackend.search,
                method: req.method ?? 'GET',
                headers,
              },
              (ores) => {
                // Free the concurrency slot as soon as backend responds with headers.
                resolve();

                res.statusCode = ores.statusCode ?? 500;
                copyHeaders(ores.headers, res, this.noProxyHeaders);

                if (res.statusCode < 200 || res.statusCode >= 300) {
                  log(
                    'statusCode %d from backend not in 200 range - proxying back to caller',
                    res.statusCode,
                  );
                  finish({ statusCode: res.statusCode });
                  res.end();
                  return;
                }

                const policy = new CachePolicy(
                  { method: req.method ?? 'GET', url: parsedUrl.pathname, headers: req.headers },
                  { status: ores.statusCode ?? 200, headers: ores.headers },
                );

                if (!policy.storable()) {
                  log('backend response not cacheable - proxying without caching');
                  finish({ statusCode: res.statusCode });
                  ores.pipe(res);
                  return;
                }

                fs.mkdir(path.dirname(file), { recursive: true }, () => {
                  const tmp = `${file}.in-progress`;
                  log('saving local file to %s', tmp);
                  const ws = fs.createWriteStream(tmp);

                  ws.once('finish', () => {
                    fs.rename(tmp, file, (renameErr) => {
                      if (renameErr) {
                        log('failed to rename %s to %s', tmp, file);
                        finish({ statusCode: 500 });
                        return;
                      }
                      log('renamed %s to %s', tmp, file);
                      finish({ ores });
                    });
                  });

                  ws.once('error', (e) => {
                    log('failed to save local file %s', e.message);
                    ores.unpipe(ws);
                    finish({ statusCode: 500 });
                  });

                  const ores_ws = new PassThrough();
                  const ores_res = new PassThrough();
                  ores.pipe(ores_ws);
                  ores.pipe(ores_res);
                  ores_ws.pipe(ws);
                  ores_res.pipe(res);
                });
              },
            );

            oreq.on('error', (e) => {
              resolve();
              log('error with proxy request %s', e.message);
              res.statusCode = 500;
              res.end();
              finish({ statusCode: 500 });
            });

            oreq.end();
          }),
      );
    });
  }

  private _log(format: string, ...args: unknown[]): void {
    this.emit('log', util.format(format, ...args));
  }

  private _makeRequest(
    opts: http.RequestOptions,
    cb: (res: http.IncomingMessage) => void,
  ): http.ClientRequest {
    return this.backendHttps ? https.request(opts, cb) : http.request(opts, cb);
  }
}

function logAccess(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cb: (line: string) => void,
): void {
  res.once('finish', () => {
    const remote = req.socket?.remoteAddress ?? '-';
    const ts = new Date().toUTCString();
    const method = req.method ?? '-';
    const url = req.url ?? '-';
    const proto = `HTTP/${req.httpVersion}`;
    const status = res.statusCode;
    const size = res.getHeader('content-length') ?? '-';
    cb(`${remote} - - [${ts}] "${method} ${url} ${proto}" ${status} ${size}`);
  });
}

function buildProxyHeaders(
  incoming: http.IncomingHttpHeaders,
  skip: string[],
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const header of Object.keys(incoming)) {
    if (!skip.includes(header)) {
      out[header] = incoming[header];
    }
  }
  return out;
}

function copyHeaders(
  src: http.IncomingHttpHeaders,
  res: http.ServerResponse,
  skip: string[],
): void {
  for (const header of Object.keys(src)) {
    if (!skip.includes(header)) {
      const val = src[header];
      if (val !== undefined) {
        res.setHeader(header, val);
      }
    }
  }
}

function streamFile(
  file: string,
  stats: fs.Stats,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const etag = `"${stats.size}-${stats.mtime.getTime()}"`;

  res.setHeader('Last-Modified', stats.mtime.toUTCString());
  res.setHeader('Content-Type', mime.lookup(file) || 'application/octet-stream');
  res.setHeader('ETag', etag);

  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  res.setHeader('Content-Length', stats.size);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const rs = fs.createReadStream(file);
  pipeline(rs, res).catch((err: NodeJS.ErrnoException) => {
    if (!res.headersSent) {
      res.statusCode = err.code === 'ENOENT' ? 404 : 500;
      res.end();
    }
  });
}
