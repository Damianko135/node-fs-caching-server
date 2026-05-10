#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { FsCachingServer } from './server.js';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../package.json') as { version: string };

const DEFAULT_HOST = process.env['FS_CACHE_HOST'] ?? '0.0.0.0';
const DEFAULT_PORT = process.env['FS_CACHE_PORT'] ?? '8080';
const DEFAULT_CACHE_DIR = process.env['FS_CACHE_DIR'] ?? process.cwd();

const USAGE = `
usage: fs-caching-server [options]

options
  -c, --cache-dir <dir>     [env FS_CACHE_DIR] directory for caching, defaults to CWD
  -d, --debug               enable debug logging to stderr
  -H, --host <host>         [env FS_CACHE_HOST] host to listen on, defaults to ${DEFAULT_HOST}
  -h, --help                print this message and exit
  -p, --port <port>         [env FS_CACHE_PORT] port to listen on, defaults to ${DEFAULT_PORT}
  -r, --regex <regex>       [env FS_CACHE_REGEX] regex to match for caching
  -U, --url <url>           [env FS_CACHE_URL] URL to proxy to (required)
  -v, --version             print the version number and exit
`.trim();

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'cache-dir': { type: 'string', short: 'c', default: DEFAULT_CACHE_DIR },
      debug: { type: 'boolean', short: 'd', default: false },
      host: { type: 'string', short: 'H', default: DEFAULT_HOST },
      help: { type: 'boolean', short: 'h', default: false },
      port: { type: 'string', short: 'p', default: DEFAULT_PORT },
      regex: { type: 'string', short: 'r', default: process.env['FS_CACHE_REGEX'] },
      url: { type: 'string', short: 'U', default: process.env['FS_CACHE_URL'] },
      version: { type: 'boolean', short: 'v', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (values.version) {
    console.log(pkg.version);
    process.exit(0);
  }

  if (!values.url) {
    console.error('url must be specified with `-U <url>` or as FS_CACHE_URL');
    process.exit(1);
  }

  const portNum = parseInt(values.port!, 10);
  if (isNaN(portNum)) {
    console.error('port must be a number, got "%s"', values.port);
    process.exit(1);
  }

  let regex: RegExp | undefined;
  if (values.regex) {
    regex = new RegExp(values.regex);
  }

  const backendUrl = values.url.replace(/\/*$/, '');

  const server = new FsCachingServer({
    host: values.host!,
    port: portNum,
    backendUrl,
    cacheDir: values['cache-dir']!,
    regex,
  });

  server.on('access-log', console.log);
  if (values.debug) {
    server.on('log', console.error);
  }

  server.start();
}

main();
