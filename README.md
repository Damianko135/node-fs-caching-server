# fs-caching-server

A caching HTTP proxy that stores responses on the local filesystem. Requests matching a configurable regex are cached on first fetch and served from disk on subsequent requests — bypassing the backend entirely.

## How it works

- **Cache miss** — request is proxied to the backend, response is streamed to the client and written to disk simultaneously.
- **Cache hit** — file is served directly from disk with `ETag` / `If-None-Match` support (304 responses).
- **Concurrent misses for the same file** — only one backend request is made; other requests queue and are served from disk once the download completes.
- **Non-cacheable responses** — responses with `Cache-Control: no-store` or similar directives are proxied through without being written to disk.

## Getting started

```sh
git clone https://github.com/Damianko135/node-fs-caching-server.git
cd node-fs-caching-server
pnpm install
```

## Running

### Option 1 — Node.js (build once, run anywhere with Node)

```sh
pnpm run build        # compiles TypeScript → dist/
node dist/cli.js -U https://registry.npmjs.org -c ./cache
```

You only need to rebuild when the source changes. The `dist/` directory is the only thing you need to ship (alongside `node_modules`).

### Option 2 — Bun (no build step, run TypeScript directly)

If you have [Bun](https://bun.sh) installed you can skip the build entirely:

```sh
bun src/cli.ts -U https://registry.npmjs.org -c ./cache
```

Bun runs TypeScript natively so no compilation is needed.

### Option 3 — Standalone binary (no Node or Bun required on target)

```sh
pnpm run compile      # produces fs-caching-server / fs-caching-server.exe
```

The output is a single self-contained executable with the Bun runtime embedded. Copy it to any machine and run it — no runtime dependencies needed.

```sh
./fs-caching-server -U https://registry.npmjs.org -c ./cache
```

## CLI

```
usage: fs-caching-server [options]

options
  -c, --cache-dir <dir>     [env FS_CACHE_DIR]   directory for caching, defaults to CWD
  -d, --debug               [env FS_CACHE_DEBUG] enable debug logging to stderr
  -H, --host <host>         [env FS_CACHE_HOST]  host to listen on, defaults to 0.0.0.0
  -h, --help                print this message and exit
  -p, --port <port>         [env FS_CACHE_PORT]  port to listen on, defaults to 8080
  -r, --regex <regex>       [env FS_CACHE_REGEX] regex to match for caching
  -U, --url <url>           [env FS_CACHE_URL]   URL to proxy to (required)
  -v, --version             print the version number and exit
```

All flags can be set via environment variables. `FS_CACHE_DEBUG` enables debug mode when set to any non-empty value.

### Example

```sh
mkdir cache
fs-caching-server -U https://pkgsrc.joyent.com -c cache/ -d
```

```
listening on http://0.0.0.0:8080
proxying requests to https://pkgsrc.joyent.com
caching matches of /\.(png|jpg|jpeg|css|html|js|tar|tgz|tar\.gz)$/
caching to /home/user/cache
max concurrent backend fetches: 10
```

With `-d` debug output shows whether each request was a cache hit, miss, or skipped:

```
[a1b2c3d4] INCOMING REQUEST - GET /packages/file.tgz
[a1b2c3d4] proxying GET to https://pkgsrc.joyent.com/packages/file.tgz
[a1b2c3d4] saving local file to ./cache/packages/file.tgz.in-progress
[a1b2c3d4] renamed .../file.tgz.in-progress to .../file.tgz
...
[e5f6a7b8] INCOMING REQUEST - GET /packages/file.tgz
[e5f6a7b8] .../file.tgz is a file (cached) - streaming to client
```

## Module API

The server can be used as a TypeScript/JavaScript module:

```typescript
import { FsCachingServer } from 'fs-caching-server';

const server = new FsCachingServer({
  host: '0.0.0.0',
  port: 8080,
  backendUrl: 'https://pkgsrc.joyent.com',
  cacheDir: '/tmp/cache',
});

server.on('access-log', console.log);
server.on('log', console.error); // debug logs

server.start();
```

### Options

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `host` | `string` | yes | — | Host to bind to |
| `port` | `number` | yes | — | Port to bind to |
| `backendUrl` | `string` | yes | — | Backend URL to proxy to |
| `cacheDir` | `string` | yes | — | Directory for cached files |
| `regex` | `RegExp` | no | `\.(png\|jpg\|jpeg\|css\|html\|js\|tar\|tgz\|tar\.gz)$` | Which paths to cache |
| `noProxyHeaders` | `string[]` | no | `['date', 'server', 'host']` | Headers stripped before proxying |
| `cacheMethods` | `string[]` | no | `['GET', 'HEAD']` | HTTP methods eligible for caching |
| `maxConcurrency` | `number` | no | `10` | Max simultaneous backend fetches |

### Methods

- **`.start()`** — start the server.
- **`.stop()`** — stop the server.
- **`.onIdle(cb)`** — call `cb` when there are no pending filesystem writes. Useful for tests.

### Events

| Event | Description |
|---|---|
| `start` | Server is listening |
| `stop` | Server has closed |
| `access-log` | Per-request Apache CLF-formatted log line |
| `log` | Internal debug log messages |
| `idle` | No pending filesystem writes remain |

## SMF (Solaris / illumos)

An SMF service manifest is provided in `smf/manifest.xml` for running the server as a managed service on Solaris, illumos, or SmartOS.

```sh
svccfg import smf/manifest.xml
svcadm enable fs-caching-server
```

Configure via the environment variables in the manifest (`FS_CACHE_URL`, `FS_CACHE_DIR`, `FS_CACHE_DEBUG`, etc.).

## Testing

```sh
# copy the default config (adjust ports if needed)
cp tests/dist-config.json tests/config.json

pnpm test
```

## License

MIT
