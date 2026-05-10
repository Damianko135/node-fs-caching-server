declare module 'access-log' {
  import { IncomingMessage, ServerResponse } from 'node:http';
  function accesslog(
    req: IncomingMessage,
    res: ServerResponse,
    format: string | undefined,
    cb: (line: string) => void,
  ): void;
  export = accesslog;
}
