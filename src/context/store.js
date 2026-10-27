import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {object} StoredMessage
 * @property {'user'|'assistant'} role
 * @property {string} text
 * @property {string} [name]
 * @property {string|null} [imageUrl]
 * @property {number} ts
 * @property {string} [messageId]
 */

/**
 * @typedef {object} ChatRecord
 * @property {string} chatId
 * @property {string} chatType
 * @property {string} summary
 * @property {StoredMessage[]} messages
 * @property {number} turns
 * @property {number} updatedAt
 * @property {{thinking: string|null}} meta
 */

/**
 * Lưu ngữ cảnh theo chat dưới dạng JSON, ghi atomic + debounce.
 * @param {{dir: string, logger?: import('../logger.js').Logger, ttlHours?: number, maxChats?: number, debounceMs?: number, now?: () => number}} options
 */
export function createContextStore(options) {
  const dir = options.dir;
  const logger = options.logger;
  const ttlMs = (options.ttlHours ?? 72) * 3_600_000;
  const maxChats = options.maxChats ?? 50;
  const debounceMs = options.debounceMs ?? 500;
  const now = options.now ?? (() => Date.now());

  /** @type {Map<string, ChatRecord>} */
  const memory = new Map();
  /** @type {Map<string, NodeJS.Timeout>} */
  const timers = new Map();
  /** @type {Set<string>} */
  const dirty = new Set();

  /** @param {string} chatId */
  function fileFor(chatId) {
    const hash = crypto.createHash('sha1').update(chatId).digest('hex').slice(0, 24);
    return path.join(dir, `${hash}.json`);
  }

  async function init() {
    await fsp.mkdir(dir, { recursive: true });
    await prune();
  }

  /** @param {string} chatId @param {string} chatType */
  function freshRecord(chatId, chatType) {
    return {
      chatId,
      chatType,
      summary: '',
      messages: [],
      turns: 0,
      updatedAt: now(),
      meta: { thinking: null },
    };
  }

  /** @param {unknown} value @returns {value is ChatRecord} */
  function isRecord(value) {
    return Boolean(
      value &&
        typeof value === 'object' &&
        typeof (/** @type {any} */ (value).chatId) === 'string' &&
        Array.isArray(/** @type {any} */ (value).messages),
    );
  }

  /** @param {ChatRecord} record */
  async function persist(record) {
    const file = fileFor(record.chatId);
    const tmp = `${file}.${process.pid}.tmp`;
    const payload = JSON.stringify(record);
    await fsp.writeFile(tmp, payload, 'utf8');
    await fsp.rename(tmp, file);
  }

  /** @param {string} chatId */
  function scheduleSave(chatId) {
    dirty.add(chatId);
    const existing = timers.get(chatId);
    if (existing) return;
    const timer = setTimeout(() => {
      timers.delete(chatId);
      const record = memory.get(chatId);
      if (!record || !dirty.has(chatId)) return;
      dirty.delete(chatId);
      persist(record).catch((error) => logger?.warn('save context failed', { chatId, error }));
    }, debounceMs);
    timer.unref?.();
    timers.set(chatId, timer);
  }

  /**
   * @param {string} chatId
   * @param {{chatType?: string}} [meta]
   * @returns {Promise<ChatRecord>}
   */
  async function get(chatId, meta = {}) {
    const cached = memory.get(chatId);
    if (cached) {
      memory.delete(chatId);
      memory.set(chatId, cached);
      if (meta.chatType) cached.chatType = meta.chatType;
      return cached;
    }

    /** @type {ChatRecord|null} */
    let loaded = null;
    try {
      const raw = await fsp.readFile(fileFor(chatId), 'utf8');
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) loaded = parsed;
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code !== 'ENOENT') {
        logger?.warn('read context failed, starting fresh', { chatId, error });
      }
    }

    const record = loaded ?? freshRecord(chatId, meta.chatType ?? 'UNKNOWN');
    if (meta.chatType) record.chatType = meta.chatType;
    if (!record.meta) record.meta = { thinking: null };
    if (!Array.isArray(record.messages)) record.messages = [];
    memory.set(chatId, record);
    evictIfNeeded();
    return record;
  }

  function evictIfNeeded() {
    while (memory.size > maxChats) {
      const oldestKey = memory.keys().next().value;
      if (oldestKey === undefined) break;
      const record = memory.get(oldestKey);
      memory.delete(oldestKey);
      if (record && dirty.has(oldestKey)) {
        dirty.delete(oldestKey);
        persist(record).catch((error) => logger?.warn('evict save context failed', { error }));
      }
    }
  }

  /** @param {string} chatId */
  function touch(chatId) {
    const record = memory.get(chatId);
    if (!record) return;
    record.updatedAt = now();
    scheduleSave(chatId);
  }

  /**
   * Xoá ngữ cảnh của một chat.
   * @param {string} chatId
   * @param {{keepMeta?: boolean}} [options] `keepMeta: true` → chỉ xoá messages/summary/turns,
   *   giữ `meta` (tone/model/thinking). Mặc định xoá sạch file như cũ.
   */
  async function reset(chatId, options = {}) {
    const timer = timers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(chatId);
    }
    dirty.delete(chatId);
    const removed = memory.get(chatId) ?? null;

    if (options.keepMeta && removed) {
      removed.messages = [];
      removed.summary = '';
      removed.turns = 0;
      removed.updatedAt = now();
      memory.set(chatId, removed);
      await persist(removed);
      return removed;
    }

    memory.delete(chatId);
    try {
      await fsp.unlink(fileFor(chatId));
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code !== 'ENOENT') logger?.warn('delete context file failed', { chatId, error });
    }
    return removed;
  }

  async function flush() {
    const pending = [...dirty];
    for (const chatId of pending) {
      const timer = timers.get(chatId);
      if (timer) {
        clearTimeout(timer);
        timers.delete(chatId);
      }
      const record = memory.get(chatId);
      if (!record) {
        dirty.delete(chatId);
        continue;
      }
      try {
        await persist(record);
        dirty.delete(chatId);
      } catch (error) {
        // giữ dirty và thử lại sau, tránh mất dữ liệu
        logger?.warn('flush context failed', { chatId, error });
        scheduleSave(chatId);
      }
    }
  }

  async function prune() {
    // ttlHours = 0 → không bao giờ tự xoá context
    if (ttlMs <= 0) return 0;
    let entries;
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return 0;
    }
    const files = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(dir, name);
      try {
        const stat = await fsp.stat(full);
        files.push({ full, mtimeMs: stat.mtimeMs });
      } catch {
        // ignore
      }
    }
    let removed = 0;
    const cutoff = now() - ttlMs;
    for (const file of files) {
      if (file.mtimeMs < cutoff) {
        try {
          await fsp.unlink(file.full);
          removed += 1;
        } catch {
          // ignore
        }
      }
    }
    return removed;
  }

  /** @param {string} chatId */
  function has(chatId) {
    return memory.has(chatId);
  }

  function loadedChats() {
    return memory.size;
  }

  /** Số file context đang có trên đĩa (chỉ file .json). */
  async function count() {
    let entries;
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return 0;
    }
    return entries.filter((name) => name.endsWith('.json')).length;
  }

  return { init, get, reset, touch, flush, prune, has, loadedChats, count, scheduleSave, fileFor };
}
