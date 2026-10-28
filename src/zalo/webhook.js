import crypto from 'node:crypto';
import http from 'node:http';
import { normalizeUpdates } from './events.js';

const MAX_BODY_BYTES = 256 * 1024;

/**
 * @param {string} a
 * @param {string} b
 */
function safeEqual(a, b) {
  const left = Buffer.from(a ?? '');
  const right = Buffer.from(b ?? '');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Webhook server built on node:http (no framework dependency).
 * @param {{config: any, logger: import('../logger.js').Logger, metrics?: any, onEvent: (event: import('./events.js').BotEvent) => void}} options
 */
export function createWebhookServer(options) {
  const config = options.config;
  const logger = options.logger;
  const metrics = options.metrics;
  const onEvent = options.onEvent;
  const path = config.webhook.path;

  /** @type {http.Server|null} */
  let server = null;

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handle(req, res) {
    // Strip the query string when matching the path
    const pathname = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptimeSec: Math.round(process.uptime()) }));
      return;
    }

    if (pathname !== path || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }

    const secret = String(req.headers['x-bot-api-secret-token'] ?? '');
    if (!safeEqual(secret, config.webhook.secret)) {
      logger.warn('webhook rejected: bad secret', { ip: req.socket.remoteAddress });
      metrics?.inc('webhook.rejected');
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }

    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        metrics?.inc('webhook.tooLarge');
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'payload too large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      metrics?.inc('webhook.received');

      // Parse before returning 200: on a broken body Zalo must know so it can retry.
      let payload = null;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        logger.warn('webhook body is not JSON', { error: String(error) });
        metrics?.inc('webhook.invalidJson');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      const events = normalizeUpdates(payload);
      if (!events.length) {
        logger.debug('webhook without message event', { keys: Object.keys(payload ?? {}) });
        return;
      }
      setImmediate(() => {
        for (const event of events) {
          try {
            onEvent(event);
          } catch (error) {
            logger.error('onEvent handler threw', { error });
          }
        }
      });
    });

    req.on('error', (error) => {
      logger.warn('webhook request error', { error: String(error) });
    });
  }

  /**
   * @returns {Promise<{port: number, url: string}>}
   */
  async function start() {
    server = http.createServer((req, res) => {
      handle(req, res).catch((error) => {
        logger.error('webhook handler crashed', { error });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 70_000;

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.webhook.port, config.webhook.host || '127.0.0.1', () => resolve(undefined));
    });

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.webhook.port;
    return { port, url: `http://${config.webhook.host || '127.0.0.1'}:${port}${path}` };
  }

  async function stop() {
    if (!server) return;
    const current = server;
    server = null;
    await new Promise((resolve) => current.close(() => resolve(undefined)));
  }

  return { start, stop, get server() { return server; } };
}
