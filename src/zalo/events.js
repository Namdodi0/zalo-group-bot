/**
 * @typedef {object} BotEvent
 * @property {'text'|'image'|'sticker'|'voice'|'unsupported'|'unknown'} kind
 * @property {string} chatId
 * @property {string} chatType
 * @property {string} senderId
 * @property {string} senderName
 * @property {boolean} isBot
 * @property {string} text
 * @property {string|null} imageUrl
 * @property {string|null} sticker
 * @property {string} messageId
 * @property {number} date
 * @property {string} eventName
 */

const KIND_BY_EVENT = {
  'message.text.received': 'text',
  'message.image.received': 'image',
  'message.sticker.received': 'sticker',
  'message.voice.received': 'voice',
  'message.unsupported.received': 'unsupported',
};

/** @param {unknown} value */
function asString(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

/** Pick a URL from a string/array/object (Zalo has shipped several shapes for photos). */
function asUrl(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = asUrl(item);
      if (url) return url;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    const row = /** @type {any} */ (value);
    return asString(row.url ?? row.photo_url ?? row.href ?? row.link ?? '');
  }
  return '';
}

/** Pick a sticker id from a string/array/object. */
function asStickerId(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = asStickerId(item);
      if (id) return id;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    const row = /** @type {any} */ (value);
    return asString(row.id ?? row.sticker_id ?? row.sticker ?? '');
  }
  return '';
}

/**
 * Zalo may return `result` as an object or an array depending on the version.
 * @param {unknown} payload
 * @returns {unknown[]}
 */
export function extractResults(payload) {
  const data = /** @type {any} */ (payload);
  if (!data) return [];
  const result = data.result ?? data;
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') return [result];
  return [];
}

/**
 * @param {unknown} item
 * @returns {BotEvent|null}
 */
export function toEvent(item) {
  const row = /** @type {any} */ (item);
  if (!row || typeof row !== 'object') return null;
  const result = row.result ?? row;
  const message = result.message ?? result;
  const chat = message.chat ?? {};
  const from = message.from ?? {};
  const chatId = asString(chat.id) || asString(from.id);
  if (!chatId) return null;

  const eventName = asString(result.event_name ?? row.event_name);
  const kind = KIND_BY_EVENT[eventName] ?? 'unknown';
  const chatTypeRaw = asString(chat.chat_type ?? chat.type);
  const chatType = chatTypeRaw
    ? chatTypeRaw.toUpperCase()
    : chatId === asString(from.id)
      ? 'PRIVATE'
      : 'UNKNOWN';

  return {
    kind: /** @type {any} */ (kind),
    chatId,
    chatType,
    senderId: asString(from.id),
    senderName: asString(from.display_name) || asString(from.name) || 'Member',
    isBot: from.is_bot === true,
    text: asString(message.text) || asString(message.caption),
    imageUrl: asUrl(message.photo) || null,
    sticker: asStickerId(message.sticker) || null,
    messageId: asString(message.message_id),
    date: Number(message.date) || 0,
    eventName,
  };
}

/**
 * @param {unknown} payload
 * @returns {BotEvent[]}
 */
export function normalizeUpdates(payload) {
  /** @type {BotEvent[]} */
  const events = [];
  for (const item of extractResults(payload)) {
    const event = toEvent(item);
    if (event) events.push(event);
  }
  return events;
}
