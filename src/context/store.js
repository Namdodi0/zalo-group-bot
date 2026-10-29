import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { freshRecord, normalizeRecord } from './record.js';

/**
 * @typedef {object} StoredMessage
 * @property {'user'|'assistant'|'tool'} role
 * @property {string} [kind] turn | context | summary | tool-call | tool-result
 * @property {string} text
 * @property {string} [name]
 * @property {string} [source]
 * @property {number} ts
 * @property {string} [messageId]
 * @property {string} [toolCallId]
 * @property {Array<{id: string, name: string, arguments: any, rawArguments?: string}>} [toolCalls]
 */

/**
 * @typedef {object} ChatRecord
 * @property {number} schemaVersion
 * @property {string} chatId
 * @property {string} chatType
 * @property {StoredMessage[]} messages
 * @property {number} turns
 * @property {number} updatedAt
 * @property {{thinking?: string|null, tone?: string|null, model?: string|null, split?: string|null}} meta
 * @property {string[]} [seen] recent message_ids — prevents duplicate processing after restart
 */

/**
 * Persist context per chat as JSON, written atomically + debounced.
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

  /** @param {unknown} value @returns {value is ChatRecord} */
  function isRecord(value) {
    return Boolean(
      value &&
        typeof value === 'object' &&
        typeof (/** @type {any} */ (value).chatId) === 'string' &&
        Array.isArray(/** @type {any} */ (value).messages),
    );
  }

  /** @type {Map<string, number>} */
  const epochs = new Map();

  let writeSeq = 0;

  /** @param {ChatRecord} record */
  async function persist(record) {
    const file = fileFor(record.chatId);
    // A reset between "write temp" and "rename" must not resurrect the old file.
    const epoch = epochs.get(record.chatId) ?? 0;
    // Unique tmp name: debounce and flush() can write the same chat concurrently.
    writeSeq += 1;
    const tmp = `${file}.${process.pid}.${writeSeq}.tmp`;
    const payload = JSON.stringify(record);
    await fsp.writeFile(tmp, payload, 'utf8');
    if ((epochs.get(record.chatId) ?? 0) !== epoch) {
      try {
        await fsp.unlink(tmp);
      } catch {
        // ignore
      }
      return;
    }
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
      if (isRecord(parsed)) loaded = normalizeRecord(parsed);
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      if (code !== 'ENOENT') {
        logger?.warn('read context failed, starting fresh', { chatId, error });
      }
    }

    const record = normalizeRecord(loaded ?? freshRecord(chatId, meta.chatType ?? 'UNKNOWN', now()));
    if (meta.chatType) record.chatType = meta.chatType;
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
   * Delete the context of a chat.
   * @param {string} chatId
   * @param {{keepMeta?: boolean}} [options] `keepMeta: true` → only clear messages/summary/turns,
   *   keep `meta` (tone/model/thinking). By default the whole file is removed as before.
   */
  async function reset(chatId, options = {}) {
    epochs.set(chatId, (epochs.get(chatId) ?? 0) + 1);
    const timer = timers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(chatId);
    }
    dirty.delete(chatId);
    const removed = memory.get(chatId) ?? null;

    if (options.keepMeta && removed) {
      removed.messages = [];
      removed.turns = 0;
      removed.schemaVersion = 2;
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
        // keep it dirty and retry later so no data is lost
        logger?.warn('flush context failed', { chatId, error });
        scheduleSave(chatId);
      }
    }
  }

  async function prune() {
    // ttlHours = 0 → never delete context automatically
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
    // If the file was deleted but the in-memory copy is still there, TTL is
    // ineffective for open chats: drop the old record too (the chat reloads from disk fresh next time).
    for (const [chatId, record] of [...memory]) {
      // Keep records with a weird/missing updatedAt (corrupt old file); do not assume they expired.
      if (dirty.has(chatId) || !Number.isFinite(record.updatedAt) || record.updatedAt >= cutoff) continue;
      const timer = timers.get(chatId);
      if (timer) {
        clearTimeout(timer);
        timers.delete(chatId);
      }
      memory.delete(chatId);
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

  /** Number of context files currently on disk (only .json files). */
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
