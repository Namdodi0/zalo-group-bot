/**
 * Reminders: `/remind <time> <text>` delivered into the same chat later.
 *
 * Times are parsed in Vietnam time (UTC+7, no DST) and persisted to a JSON file so they
 * survive restarts. The store is injectable (now/send/logger) so it can be tested without
 * real timers or the Zalo API.
 */

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_DELAY_MS = 5_000;
const MAX_DELAY_MS = 30 * DAY_MS;
const MAX_LATE_MS = 7 * DAY_MS;
const MAX_PER_CHAT = 5;
const MAX_TOTAL = 100;
const MAX_REMINDER_CHARS = 300;
const RETRY_LIMIT = 5;

/** @param {number} nowMs */
function vnParts(nowMs) {
  const date = new Date(nowMs + VN_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** Epoch ms for a Vietnam wall-clock time. */
function vnEpoch(year, month, day, hours, minutes) {
  return Date.UTC(year, month - 1, day, hours, minutes) - VN_OFFSET_MS;
}

/** Same wall-clock time on the following Vietnam day. @param {number} at */
function nextDay(at) {
  const base = new Date(at + VN_OFFSET_MS);
  return (
    Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate() + 1,
      base.getUTCHours(),
      base.getUTCMinutes(),
    ) - VN_OFFSET_MS
  );
}

/**
 * Parse `/remind` arguments.
 * Supported: `+10m` `+2h` `+1d`, `HH:MM`, `HH:MM tomorrow|mai|mốt`, `HH:MM dd/mm`.
 * @param {string} args
 * @param {number} [now]
 * @returns {{at?: number, text?: string, error?: string}}
 */
export function parseReminderArgs(args, now = Date.now()) {
  const input = String(args ?? '').trim();
  if (!input) {
    return { error: 'Usage: `/remind <time> <text>` — e.g. `/remind 20:00 tomorrow team meeting`' };
  }
  const tokens = input.split(/\s+/);
  const first = tokens[0];
  let at = null;
  let consumed = 1;

  const relative = /^\+(\d{1,4})([mhd])$/i.exec(first);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const unitMs = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : DAY_MS;
    at = now + amount * unitMs;
  } else {
    const clock = /^(\d{1,2}):(\d{2})$/.exec(first);
    if (clock) {
      const hours = Number(clock[1]);
      const minutes = Number(clock[2]);
      if (hours > 23 || minutes > 59) return { error: `Invalid time: "${first}"` };
      const current = vnParts(now);
      let year = current.year;
      let month = current.month;
      let day = current.day;
      let explicitDay = false;
      const next = String(tokens[1] ?? '').toLowerCase();
      if (['tomorrow', 'mai', 'mốt', 'mot'].includes(next)) {
        consumed = 2;
        explicitDay = true;
        const offset = ['tomorrow', 'mai'].includes(next) ? DAY_MS : 2 * DAY_MS;
        const shifted = new Date(Date.UTC(year, month - 1, day) + offset);
        year = shifted.getUTCFullYear();
        month = shifted.getUTCMonth() + 1;
        day = shifted.getUTCDate();
      } else if (/^\d{1,2}[/-]\d{1,2}$/.test(next)) {
        consumed = 2;
        explicitDay = true;
        const [d, m] = next.split(/[/-]/).map(Number);
        if (d < 1 || d > 31 || m < 1 || m > 12) return { error: `Invalid date: "${next}"` };
        // Reject days a month does not have (31/02 must not silently roll into March).
        const probe = new Date(Date.UTC(year, m - 1, d));
        if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
          return { error: `Invalid date: "${next}"` };
        }
        day = d;
        month = m;
      }
      at = vnEpoch(year, month, day, hours, minutes);
      if (!explicitDay && at <= now) at = nextDay(at);
    }
  }

  if (!Number.isFinite(at)) {
    return {
      error:
        'Could not understand the time. Use `HH:MM`, `HH:MM tomorrow`, `HH:MM 25/12`, `+10m`, `+2h` or `+1d`.',
    };
  }
  const text = tokens.slice(consumed).join(' ').trim();
  if (!text) return { error: 'Missing reminder text. Example: `/remind 20:00 tomorrow team meeting`' };
  if (text.length > MAX_REMINDER_CHARS) return { error: `Reminder text is too long (max ${MAX_REMINDER_CHARS} characters).` };
  const delay = at - now;
  if (delay < MIN_DELAY_MS) return { error: 'The reminder time must be in the future.' };
  if (delay > MAX_DELAY_MS) return { error: 'Reminders can only be set up to 30 days ahead.' };
  return { at, text };
}

/** @param {number} at */
export function formatReminderTime(at) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour12: false,
  })
    .format(new Date(at))
    .replace(',', '');
}

/**
 * @param {{file?: string|null, send?: (chatId: string, text: string) => Promise<unknown>, logger?: import('../logger.js').Logger, now?: () => number, pollMs?: number}} [options]
 */
export function createReminderStore(options = {}) {
  const file = options.file ?? null;
  const send = options.send ?? (async () => {});
  const logger = options.logger;
  const now = options.now ?? (() => Date.now());
  const pollMs = options.pollMs ?? 15_000;

  /** @type {Array<{id: number, chatId: string, text: string, at: number, createdAt: number, createdBy: string, attempts: number}>} */
  let items = [];
  let nextId = 1;
  /** @type {NodeJS.Timeout|null} */
  let timer = null;

  async function load() {
    if (!file) return items;
    try {
      const fsp = await import('node:fs/promises');
      const raw = await fsp.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.items) ? parsed.items : [];
      const cutoff = now() - MAX_LATE_MS;
      const kept = list
        .filter(
          (item) =>
            item &&
            typeof item.chatId === 'string' &&
            typeof item.text === 'string' &&
            Number.isFinite(item.at) &&
            item.at >= cutoff,
        )
        .map((item) => ({
          id: Number(item.id) || 0,
          chatId: String(item.chatId),
          text: String(item.text),
          at: Number(item.at),
          createdAt: Number(item.createdAt) || 0,
          createdBy: item.createdBy ? String(item.createdBy) : '',
          attempts: Number(item.attempts) || 0,
        }))
        .slice(0, MAX_TOTAL);
      if (kept.length < list.length) {
        logger?.warn('reminders dropped on load', { kept: kept.length, dropped: list.length - kept.length });
      }
      items = kept;
      nextId = items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
    } catch {
      // No file yet (or unreadable): start empty.
    }
    return items;
  }

  async function save() {
    if (!file) return;
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const payload = JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, payload, 'utf8');
    await fsp.rename(tmp, file);
  }

  /** @param {string} [chatId] */
  function list(chatId) {
    return chatId ? items.filter((item) => item.chatId === chatId) : items.slice();
  }

  /**
   * @param {{chatId: string, text: string, at: number, createdBy?: string}} input
   * @returns {Promise<{ok: true, item: any}|{ok: false, reason: 'chat-limit'|'total-limit'|'invalid'}>}
   */
  async function add(input) {
    const chatId = String(input?.chatId ?? '');
    const text = String(input?.text ?? '').trim();
    const at = Number(input?.at);
    if (!chatId || !text || !Number.isFinite(at)) return { ok: false, reason: 'invalid' };
    if (items.filter((item) => item.chatId === chatId).length >= MAX_PER_CHAT) {
      return { ok: false, reason: 'chat-limit' };
    }
    if (items.length >= MAX_TOTAL) return { ok: false, reason: 'total-limit' };
    const item = {
      id: nextId,
      chatId,
      text,
      at,
      createdAt: now(),
      createdBy: String(input?.createdBy ?? ''),
      attempts: 0,
    };
    nextId += 1;
    items.push(item);
    await save();
    return { ok: true, item };
  }

  /**
   * Remove by id (preferred) or by 1-based position within the chat.
   * @param {string} chatId
   * @param {string|number} query
   */
  async function remove(chatId, query) {
    const chatItems = items.filter((item) => item.chatId === chatId);
    const value = Number(query);
    let target = chatItems.find((item) => item.id === value) ?? null;
    if (!target && Number.isInteger(value) && value >= 1 && value <= chatItems.length) {
      target = chatItems[value - 1];
    }
    if (!target) return null;
    items = items.filter((item) => item.id !== target.id);
    await save();
    return target;
  }

  /** Deliver due reminders (also used by tests; `start()` calls it on an interval). */
  async function runTick() {
    const due = items.filter((item) => item.at <= now());
    if (!due.length) return 0;
    let delivered = 0;
    for (const item of due) {
      try {
        await send(item.chatId, `⏰ Reminder: ${item.text}`);
        items = items.filter((entry) => entry.id !== item.id);
        delivered += 1;
      } catch (error) {
        item.attempts += 1;
        logger?.warn('reminder send failed', {
          chatId: item.chatId,
          id: item.id,
          attempts: item.attempts,
          error: String(/** @type {any} */ (error)?.message ?? error),
        });
        if (item.attempts >= RETRY_LIMIT) {
          items = items.filter((entry) => entry.id !== item.id);
          logger?.warn('reminder dropped after retries', { chatId: item.chatId, id: item.id });
        }
      }
    }
    await save();
    return delivered;
  }

  /** @type {Promise<number>|null} */
  let tickInFlight = null;

  /** Single-flight: an overlapping tick must not deliver the same reminder twice. */
  function tick() {
    if (!tickInFlight) {
      tickInFlight = runTick().finally(() => {
        tickInFlight = null;
      });
    }
    return tickInFlight;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch((error) => logger?.warn('reminder tick failed', { error: String(/** @type {any} */ (error)?.message ?? error) }));
    }, pollMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { load, add, remove, list, tick, start, stop, all: () => items.slice(), size: () => items.length };
}

export const REMINDER_LIMITS = { MAX_PER_CHAT, MAX_TOTAL, MAX_REMINDER_CHARS };
