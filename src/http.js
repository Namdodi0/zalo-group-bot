const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, body?: string, service?: string, url?: string, retryable?: boolean, aborted?: boolean, cause?: unknown}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = meta.status ?? 0;
    this.body = meta.body ?? '';
    this.service = meta.service ?? 'unknown';
    this.url = meta.url ?? '';
    this.retryable = meta.retryable ?? false;
    // Deliberately cancelled by the caller (budget/deadline): retrying is pointless.
    this.aborted = Boolean(meta.aborted);
    this.cause = meta.cause;
  }
}

export class CircuitOpenError extends Error {
  /** @param {string} service @param {number} retryAfterMs */
  constructor(service, retryAfterMs) {
    super(`circuit open for ${service} (${retryAfterMs}ms left)`);
    this.name = 'CircuitOpenError';
    this.service = service;
    this.retryAfterMs = retryAfterMs;
  }
}

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Combine the caller signal with a timeout signal. A non-finite or <= 0 timeout means
 * "no limit": the request waits until the caller aborts or the connection drops.
 * @param {AbortSignal|undefined} signal
 * @param {number} timeoutMs
 * @returns {AbortSignal|undefined}
 */
function withTimeout(signal, timeoutMs) {
  const limit = Number(timeoutMs);
  const timeout = Number.isFinite(limit) && limit > 0 ? AbortSignal.timeout(limit) : null;
  if (!timeout) return signal;
  if (!signal) return timeout;
  // @ts-ignore AbortSignal.any is available since Node 20.3
  return AbortSignal.any([signal, timeout]);
}

/**
 * @typedef {object} HttpOptions
 * @property {import('./logger.js').Logger} [logger]
 * @property {ReturnType<typeof import('./metrics.js').createMetrics>} [metrics]
 * @property {typeof fetch} [fetchImpl]
 * @property {(ms:number)=>Promise<void>} [sleep]
 * @property {()=>number} [now]
 */

/**
 * @param {HttpOptions} [options]
 */
export function createHttp(options = {}) {
  const logger = options.logger;
  const metrics = options.metrics;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());

  const breakerThreshold = 5;
  const breakerCooldownMs = 30_000;
  /** @type {Map<string, {failures:number, openedUntil:number}>} */
  const breakers = new Map();

  /** @param {string} service */
  function breakerFor(service) {
    let state = breakers.get(service);
    if (!state) {
      state = { failures: 0, openedUntil: 0 };
      breakers.set(service, state);
    }
    return state;
  }

  /** @param {string} service */
  function assertClosed(service) {
    const state = breakerFor(service);
    if (state.openedUntil > now()) {
      throw new CircuitOpenError(service, state.openedUntil - now());
    }
  }

  /** @param {string} service */
  function recordSuccess(service) {
    const state = breakerFor(service);
    state.failures = 0;
    state.openedUntil = 0;
  }

  /** @param {string} service */
  function recordFailure(service) {
    const state = breakerFor(service);
    state.failures += 1;
    if (state.failures >= breakerThreshold) {
      state.openedUntil = now() + breakerCooldownMs;
      logger?.warn('circuit breaker opened', {
        service,
        failures: state.failures,
        cooldownMs: breakerCooldownMs,
        icon: '⛔',
      });
    }
  }

  /** @param {string} service */
  function stateOf(service) {
    const state = breakerFor(service);
    return { failures: state.failures, open: state.openedUntil > now(), openedUntil: state.openedUntil };
  }

  /** State of every service that has been called (used by /status, /metrics). */
  function listStates() {
    return [...breakers.entries()].map(([service, state]) => ({
      service,
      failures: state.failures,
      open: state.openedUntil > now(),
    }));
  }

  /**
   * @param {unknown} error
   * @param {{service: string, url: string}} meta
   * @returns {HttpError}
   */
  function normalize(error, meta) {
    if (error instanceof HttpError) return error;
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      return new HttpError(`timeout after ${meta.service} request`, {
        service: meta.service,
        url: meta.url,
        retryable: true,
        cause: error,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new HttpError(`network error: ${message}`, {
      service: meta.service,
      url: meta.url,
      retryable: true,
      cause: error,
    });
  }

  /**
   * Perform an HTTP call and return JSON, with retry + circuit breaker.
   * @param {string} url
   * @param {{method?: string, headers?: Record<string,string>, body?: string, timeoutMs?: number, retries?: number, service?: string, label?: string, signal?: AbortSignal}} [opts]
   */
  async function requestJson(url, opts = {}) {
    const service = opts.service ?? 'http';
    const retries = opts.retries ?? 2;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const method = opts.method ?? 'POST';
    let attempt = 0;

    for (;;) {
      assertClosed(service);
      const started = now();
      try {
        const response = await fetchImpl(url, {
          method,
          headers: opts.headers,
          body: opts.body,
          signal: withTimeout(opts.signal, timeoutMs),
        });
        const text = await response.text();
        const latency = now() - started;
        metrics?.recordRequest({ service, ms: latency, ok: response.ok, status: response.status });

        if (!response.ok) {
          throw new HttpError(`${service} HTTP ${response.status}`, {
            status: response.status,
            body: text.slice(0, 500),
            service,
            url,
            retryable: RETRYABLE_STATUS.has(response.status),
          });
        }

        recordSuccess(service);
        const data = text ? JSON.parse(text) : null;
        return { status: response.status, data, latencyMs: latency, headers: response.headers };
      } catch (error) {
        // Caller aborted deliberately (deadline reached) → no retry, not counted by the circuit breaker.
        if (opts.signal?.aborted) {
          const aborted = new HttpError(`${service} aborted by caller`, {
            service,
            url,
            retryable: false,
            aborted: true,
            cause: error,
          });
          throw aborted;
        }
        const err = normalize(error, { service, url });
        if (error instanceof SyntaxError) {
          throw new HttpError(`${service} returned invalid JSON`, {
            service,
            url,
            body: String(error.message).slice(0, 200),
          });
        }
        if (attempt >= retries || !err.retryable) {
          if (!(err instanceof CircuitOpenError)) recordFailure(service);
          throw err;
        }
        attempt += 1;
        const delay = Math.min(5000, 400 * 2 ** (attempt - 1)) * (0.7 + Math.random() * 0.6);
        logger?.debug('retry http request', {
          service,
          label: opts.label,
          attempt,
          delayMs: Math.round(delay),
          reason: err.message,
          icon: '🔁',
        });
        await sleep(delay);
      }
    }
  }

  /**
   * Open a stream (SSE). Retry only while no data has been read yet (connection/HTTP status error).
   * @param {string} url
   * @param {{method?: string, headers?: Record<string,string>, body?: string, timeoutMs?: number, service?: string, retries?: number, signal?: AbortSignal}} [opts]
   * @returns {Promise<Response>}
   */
  async function openStream(url, opts = {}) {
    const service = opts.service ?? 'http';
    const retries = opts.retries ?? 1;
    let attempt = 0;

    for (;;) {
      assertClosed(service);
      const started = now();
      try {
        const response = await fetchImpl(url, {
          method: opts.method ?? 'POST',
          headers: opts.headers,
          body: opts.body,
          signal: withTimeout(opts.signal, opts.timeoutMs ?? 30_000),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new HttpError(`${service} HTTP ${response.status}`, {
            status: response.status,
            body: text.slice(0, 500),
            service,
            url,
            retryable: RETRYABLE_STATUS.has(response.status),
          });
        }
        recordSuccess(service);
        metrics?.recordRequest({ service, ms: now() - started, ok: true, status: response.status });
        return response;
      } catch (error) {
        if (opts.signal?.aborted) {
          throw new HttpError(`${service} aborted by caller`, {
            service,
            url,
            retryable: false,
            aborted: true,
            cause: error,
          });
        }
        const err = normalize(error, { service, url });
        if (attempt >= retries || !err.retryable) {
          recordFailure(service);
          throw err;
        }
        attempt += 1;
        const delay = Math.min(5000, 400 * 2 ** (attempt - 1)) * (0.7 + Math.random() * 0.6);
        logger?.debug('retry stream open', { service, attempt, delayMs: Math.round(delay), reason: err.message, status: err.status, icon: '🔁' });
        await sleep(delay);
      }
    }
  }

  return { requestJson, openStream, stateOf, listStates };
}
