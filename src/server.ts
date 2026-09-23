import http, { type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = Number(process.env.PORT ?? 3000);
const HOSTNAME = '127.0.0.1';

const SHUTDOWN_DEADLINE_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024; // 64 KiB

let shuttingDown = false;

const server = http.createServer(async (req, res) => {
  // req.url is only the path + query string, so a base is needed to parse it.
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/events') {
    try {
      const event = await readJsonBody(req);
      sendJson(res, 200, { received: event });
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.statusCode, { error: error.message });
      } else {
        console.error('request_body_read_failed', { error });
        sendJson(res, 500, { error: 'internal_server_error' });
      }
    }

    return; // One return after try/catch
  }

  sendJson(res, 404, { error: 'not_found', message: 'Route not found' });
});

// TODO: maybe update these
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000; // already default in node

// TODO: shutdown and restart in case of unhandled rejections and exceptions
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOSTNAME, () => {
  console.info('server_listening', { url: `http://${HOSTNAME}:${PORT}` });
});

class HttpError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type'];

  if (!contentType?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    receivedBytes += buffer.length;

    if (receivedBytes > MAX_BODY_BYTES) {
      req.destroy();
      throw new HttpError(413, 'Request body is too large');
    }

    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);

  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });

  res.end(payload);
}

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info('shutdown_started', { signal });

  // Stop accepting new connections. Active requests may complete.
  server.close(() => {
    console.info('shutdown_complete');
    process.exit(0);
  });

  // Last resort: cut off requests still running after the deadline.
  setTimeout(() => {
    console.error('shutdown_deadline_exceeded');
    server.closeAllConnections();
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref(); // don't wait for timeout if event loop is empty
}
