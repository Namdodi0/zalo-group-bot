export class ZaloApiError extends Error {
  /**
   * @param {string} method
   * @param {{status?: number, code?: number, description?: string, body?: string}} [meta]
   */
  constructor(method, meta = {}) {
    super(`Zalo ${method} failed: ${meta.description ?? meta.body ?? 'unknown error'}`);
    this.name = 'ZaloApiError';
    this.method = method;
    this.status = meta.status ?? 0;
    this.code = meta.code ?? 0;
    this.description = meta.description ?? '';
  }
}

/**
 * Client REST mỏng cho Zalo Bot API (không phụ thuộc SDK).
 * @param {{token: string, baseUrl?: string, parseMode?: 'markdown'|'none', http: ReturnType<typeof import('../http.js').createHttp>, logger?: import('../logger.js').Logger, metrics?: any, dryRun?: boolean, typingIntervalMs?: number}} options
 */
export function createZaloClient(options) {
  const token = options.token;
  const baseUrl = (options.baseUrl ?? 'https://bot-api.zaloplatforms.com').replace(/\/+$/, '');
  const parseMode = options.parseMode ?? 'markdown';
  const http = options.http;
  const logger = options.logger;
  const metrics = options.metrics;
  const dryRun = options.dryRun ?? false;
  const typingIntervalMs = options.typingIntervalMs ?? 4000;

  /** @type {string} */
  let displayName = '';
  /** @type {Set<NodeJS.Timeout>} */
  const typingTimers = new Set();

  /**
   * Mặc định KHÔNG retry: sendMessage/sendPhoto/sendSticker là POST không idempotent,
   * retry có thể gửi trùng tin vào group.
   * @param {string} method
   * @param {Record<string, unknown>} payload
   * @param {{timeoutMs?: number, retries?: number}} [opts]
   */
  async function call(method, payload, opts = {}) {
    const url = `${baseUrl}/bot${token}/${method}`;
    const response = await http.requestJson(url, {
      service: 'zalo',
      label: method,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      timeoutMs: opts.timeoutMs ?? 10_000,
      retries: opts.retries ?? 0,
    });
    const data = /** @type {any} */ (response.data);
    if (!data || data.ok !== true) {
      throw new ZaloApiError(method, {
        status: response.status,
        code: data?.error_code ?? 0,
        description: data?.description ?? data?.message ?? '',
        body: JSON.stringify(data ?? {}).slice(0, 300),
      });
    }
    return data;
  }

  /** @param {string} method @param {Record<string, unknown>} payload */
  function mutating(method, payload) {
    if (!dryRun) return false;
    logger?.info('dry-run: skip outbound Zalo call', { method, payload: payload?.text ?? payload?.caption ?? '' });
    return true;
  }

  async function getMe() {
    const data = await call('getMe', {}, { retries: 1 });
    const result = data.result ?? {};
    displayName = String(result.display_name ?? result.account_name ?? '');
    return result;
  }

  /** Đo round-trip tới Zalo API (không gây hiệu ứng "đang soạn tin"). */
  async function ping() {
    const started = Date.now();
    await call('getMe', {}, { retries: 0, timeoutMs: 5000 });
    return Date.now() - started;
  }

  /**
   * Long-poll. Zalo trả `{ok:false, error_code:408}` khi hết timeout mà không có tin mới —
   * đó là trạng thái bình thường, không phải lỗi.
   * @param {number} [timeoutSec]
   */
  async function getUpdates(timeoutSec = 30) {
    const url = `${baseUrl}/bot${token}/getUpdates`;
    const response = await http.requestJson(url, {
      service: 'zalo',
      label: 'getUpdates',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeout: String(timeoutSec) }),
      timeoutMs: (timeoutSec + 10) * 1000,
      retries: 1,
    });
    const data = /** @type {any} */ (response.data);
    if (data?.ok === true) return data;
    if (data?.error_code === 408 || data?.description === 'Request timeout') {
      metrics?.inc('zalo.getUpdates.empty');
      return { ok: true, result: [] };
    }
    throw new ZaloApiError('getUpdates', {
      status: response.status,
      code: data?.error_code ?? 0,
      description: data?.description ?? '',
      body: JSON.stringify(data ?? {}).slice(0, 300),
    });
  }

  /**
   * @param {string} chatId
   * @param {string} text
   * @param {{parseMode?: 'markdown'|'none'}} [opts]
   */
  async function sendMessage(chatId, text, opts = {}) {
    const mode = opts.parseMode ?? parseMode;
    /** @type {Record<string, unknown>} */
    const payload = { chat_id: chatId, text };
    if (mode === 'markdown') payload.parse_mode = 'markdown';
    if (mutating('sendMessage', payload)) {
      metrics?.inc('zalo.send.dryRun');
      return { ok: true, dryRun: true };
    }
    const started = Date.now();
    const data = await call('sendMessage', payload);
    metrics?.inc('zalo.send.ok');
    metrics?.observe('zalo.sendText', Date.now() - started);
    return data;
  }

  /**
   * @param {string} chatId
   * @param {string} photoUrl
   * @param {string} [caption]
   */
  async function sendPhoto(chatId, photoUrl, caption = '') {
    /** @type {Record<string, unknown>} */
    const payload = { chat_id: chatId, photo: photoUrl };
    if (caption) payload.caption = caption.slice(0, 1900);
    if (mutating('sendPhoto', payload)) {
      metrics?.inc('zalo.send.dryRun');
      return { ok: true, dryRun: true };
    }
    const started = Date.now();
    const data = await call('sendPhoto', payload);
    metrics?.inc('zalo.sendPhoto.ok');
    metrics?.observe('zalo.sendPhoto', Date.now() - started);
    return data;
  }

  /** @param {string} chatId @param {string} [action] */
  async function sendChatAction(chatId, action = 'typing') {
    if (dryRun) return { ok: true, dryRun: true };
    return call('sendChatAction', { chat_id: chatId, action }, { retries: 0, timeoutMs: 5000 });
  }

  /** @param {string} chatId @param {string} stickerId ID gói sticker (20 hex) */
  async function sendSticker(chatId, stickerId) {
    if (mutating('sendSticker', { sticker: stickerId })) return { ok: true, dryRun: true };
    const started = Date.now();
    const data = await call('sendSticker', { chat_id: chatId, sticker: stickerId });
    metrics?.inc('zalo.sendSticker.ok');
    metrics?.observe('zalo.sendSticker', Date.now() - started);
    return data;
  }

  /**
   * Bật "đang soạn tin" và refresh định kỳ.
   * Hàm trả về `stop()` (async): dừng refresh, chờ request cuối kết thúc để indicator
   * không hiện thêm sau khi bot đã gửi tin.
   * @param {string} chatId
   * @returns {() => Promise<void>}
   */
  function startTyping(chatId) {
    if (dryRun) return async () => {};
    let stopped = false;
    /** @type {Promise<unknown>} */
    let inFlight = Promise.resolve();

    const ping = () => {
      if (stopped) return;
      inFlight = sendChatAction(chatId, 'typing').catch((error) => {
        logger?.debug('typing indicator failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
      });
    };

    ping();
    const timer = setInterval(ping, typingIntervalMs);
    timer.unref?.();
    typingTimers.add(timer);

    return async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      typingTimers.delete(timer);
      await Promise.race([
        inFlight.catch(() => {}),
        new Promise((resolve) => {
          const fallback = setTimeout(resolve, 800);
          fallback.unref?.();
        }),
      ]);
    };
  }

  /** @param {string} url @param {string} secret */
  async function setWebhook(url, secret) {
    return call('setWebhook', { url, secret_token: secret }, { retries: 1 });
  }

  async function deleteWebhook() {
    return call('deleteWebhook', {}, { retries: 1 });
  }

  async function getWebhookInfo() {
    return call('getWebhookInfo', {}, { retries: 1 });
  }

  /** @param {string} url */
  async function testWebhook(url) {
    return call('testWebhook', { url }, { retries: 1 });
  }

  function stopAllTyping() {
    for (const timer of typingTimers) clearInterval(timer);
    typingTimers.clear();
  }

  return {
    getMe,
    ping,
    getUpdates,
    sendMessage,
    sendPhoto,
    sendChatAction,
    sendSticker,
    startTyping,
    setWebhook,
    deleteWebhook,
    getWebhookInfo,
    testWebhook,
    stopAllTyping,
    get displayName() {
      return displayName;
    },
    set displayName(value) {
      displayName = value;
    },
  };
}
