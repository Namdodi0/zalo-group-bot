import { normalizeUpdates } from './events.js';

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Long-poll getUpdates.
 * @param {{zalo: ReturnType<typeof import('./client.js').createZaloClient>, onEvent: (event: import('./events.js').BotEvent) => void, logger: import('../logger.js').Logger, metrics?: any, signal?: AbortSignal, once?: boolean}} options
 */
export async function startPolling(options) {
  const { zalo, onEvent, logger } = options;
  const metrics = options.metrics;
  const signal = options.signal;
  const once = options.once ?? false;
  const timeoutSec = once ? 3 : 30;

  let backoffMs = 1000;
  let total = 0;

  logger.info('polling started', { mode: once ? 'once' : 'long-poll', timeoutSec, icon: '📡' });

  while (!signal?.aborted) {
    try {
      const payload = await zalo.getUpdates(timeoutSec, signal);
      // Shutdown giữa lúc long-poll trả về: bỏ lượt này để drain() thấy queue ổn định.
      if (signal?.aborted) break;
      backoffMs = 1000;
      const events = normalizeUpdates(payload);
      if (events.length) {
        metrics?.inc('poll.events', events.length);
        total += events.length;
        for (const event of events) {
          try {
            onEvent(event);
          } catch (error) {
            logger.error('onEvent handler threw', { error });
          }
        }
      }
      if (once) {
        logger.info('once mode finished', { events: total });
        return;
      }
    } catch (error) {
      if (signal?.aborted) break;
      logger.warn('getUpdates failed, backing off', {
        error: String(/** @type {any} */ (error)?.message ?? error),
        backoffMs,
        icon: '🔌',
      });
      await sleep(backoffMs);
      backoffMs = Math.min(30_000, backoffMs * 2);
      if (once) throw error;
    }
  }

  logger.info('polling stopped', { events: total, icon: '🛑' });
}
