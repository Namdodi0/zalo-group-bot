import { CircuitOpenError, HttpError } from '../../http.js';

/** Stable error codes — consumers route by code, not by message. */
export const LLM_ERROR = {
  NO_ADAPTER: 'NO_ADAPTER',
  MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_WINDOW_EXCEEDED',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  BAD_REQUEST: 'BAD_REQUEST',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
};

export class LlmError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{retryable?: boolean, status?: number, provider?: string, model?: string, cause?: unknown, body?: string}} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.retryable = Boolean(meta.retryable);
    this.status = meta.status ?? 0;
    this.provider = meta.provider;
    this.model = meta.model;
    this.cause = meta.cause;
    this.body = meta.body;
  }
}

const CONTEXT_MARKERS = [
  'context length',
  'context_length',
  'maximum context',
  'too many tokens',
  'prompt is too long',
  'input is too long',
  'tokens exceed',
];

/** @param {unknown} error */
function bodyOf(error) {
  const value = /** @type {any} */ (error);
  if (typeof value?.body === 'string') return value.body;
  if (value?.body !== undefined) {
    try {
      return JSON.stringify(value.body);
    } catch {
      return '';
    }
  }
  return '';
}

/** @param {string} text */
function looksLikeContextOverflow(text) {
  const lower = String(text ?? '').toLowerCase();
  return CONTEXT_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Normalize any transport/provider error into an LlmError.
 * @param {unknown} error
 * @param {{provider?: string, model?: string}} [meta]
 * @returns {LlmError}
 */
export function asLlmError(error, meta = {}) {
  if (error instanceof LlmError) return error;
  const name = String(/** @type {any} */ (error)?.name ?? '');
  const message = String(/** @type {any} */ (error)?.message ?? error);
  const body = bodyOf(error);

  if (error instanceof CircuitOpenError) {
    return new LlmError(LLM_ERROR.PROVIDER_ERROR, message, { ...meta, retryable: false, cause: error, body });
  }

  if (error instanceof HttpError) {
    const status = Number(error.status ?? 0);
    if (status === 401 || status === 403) {
      return new LlmError(LLM_ERROR.AUTH, message, { ...meta, status, retryable: false, cause: error, body });
    }
    if (looksLikeContextOverflow(`${body} ${message}`)) {
      return new LlmError(LLM_ERROR.CONTEXT_WINDOW_EXCEEDED, message, { ...meta, status, retryable: false, cause: error, body });
    }
    if (status === 408) {
      return new LlmError(LLM_ERROR.TIMEOUT, message, { ...meta, status, retryable: true, cause: error, body });
    }
    if (status === 429) {
      return new LlmError(LLM_ERROR.RATE_LIMIT, message, { ...meta, status, retryable: true, cause: error, body });
    }
    if (status >= 500) {
      return new LlmError(LLM_ERROR.PROVIDER_ERROR, message, { ...meta, status, retryable: true, cause: error, body });
    }
    if (status === 0) {
      return new LlmError(LLM_ERROR.TIMEOUT, message, { ...meta, status, retryable: true, cause: error, body });
    }
    return new LlmError(LLM_ERROR.BAD_REQUEST, message, { ...meta, status, retryable: false, cause: error, body });
  }

  if (name === 'AbortError') {
    return new LlmError(LLM_ERROR.ABORTED, message || 'request aborted', { ...meta, retryable: false, cause: error });
  }
  if (name === 'TimeoutError' || /timeout|timed out/i.test(message)) {
    return new LlmError(LLM_ERROR.TIMEOUT, message, { ...meta, retryable: true, cause: error, body });
  }
  if (looksLikeContextOverflow(`${body} ${message}`)) {
    return new LlmError(LLM_ERROR.CONTEXT_WINDOW_EXCEEDED, message, { ...meta, retryable: false, cause: error, body });
  }
  return new LlmError(LLM_ERROR.PROVIDER_ERROR, message, { ...meta, retryable: false, cause: error, body });
}

/** @param {unknown} error */
export function isRetryableLlmError(error) {
  return Boolean(error instanceof LlmError ? error.retryable : asLlmError(error).retryable);
}
