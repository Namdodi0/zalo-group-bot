/**
 * Sticker Zalo.
 *
 * LƯU Ý: `sendSticker` chỉ nhận **sticker ID chính thức** (20 hex), KHÔNG nhận
 * ID gói/category trên stickers.zaloapp.com (các ID đó trả 425 "The sticker is invalid").
 * Vì vậy:
 *  - Built-in: ID mẫu trong tài liệu Zalo Bot (đã kiểm chứng gửi được).
 *  - Extra: khai báo qua STICKER_IDS (id hoặc id:tên).
 *  - Admin thêm ID hợp lệ bằng `/sticker add <id> [tên]` (bot gửi thử rồi lưu).
 *  - Khi có người gửi sticker cho bot, mặc định bot gửi lại chính sticker đó.
 */

export const BUILTIN_STICKERS = [
  {
    id: '0e078a2fb66a5f34067b',
    name: 'Sticker Zalo mẫu',
    tags: ['chào', 'hi', 'hello', 'vui', 'mẫu'],
  },
];

/** @param {unknown} value */
export function isValidStickerId(value) {
  return /^[a-f0-9]{20}$/i.test(String(value ?? '').trim());
}

/** Bỏ dấu + lowercase để tìm "meo" khớp "Mèo", "chao" khớp "chào". */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/giu, 'd')
    .toLowerCase()
    .trim();
}

/**
 * Parse STICKER_IDS: "id1,id2:tên hai,id3" → [{id, name}]
 * @param {unknown} raw
 */
export function parseStickerIds(raw) {
  return String(raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [id, ...rest] = part.split(':');
      return { id: id.trim(), name: rest.join(':').trim() || undefined };
    })
    .filter((item) => isValidStickerId(item.id));
}

/** @param {{id: string, name?: string, tags?: string[]}} item */
function enrich(item) {
  const name = String(item.name ?? `Sticker ${String(item.id).slice(0, 6)}`);
  const tags = new Set((item.tags ?? []).map((tag) => String(tag).toLowerCase()));
  for (const word of normalizeText(name).split(/\s+/)) {
    if (word.length >= 3) tags.add(word);
  }
  return { id: String(item.id), name, tags: [...tags] };
}

/**
 * @param {{file?: string, items?: any[], extraIds?: Array<{id: string, name?: string}>, logger?: import('../logger.js').Logger}} [options]
 */
export function createStickerStore(options = {}) {
  const file = options.file;
  const logger = options.logger;
  const builtin = (options.items ?? BUILTIN_STICKERS).map(enrich);
  const extra = (options.extraIds ?? []).filter((item) => isValidStickerId(item.id)).map(enrich);
  /** @type {Array<{id: string, name: string, tags: string[]}>} */
  let custom = [];
  /** @type {Array<{id: string, name: string, tags: string[]}>} */
  let items = [];

  function rebuild() {
    /** @type {Map<string, {id: string, name: string, tags: string[]}>} */
    const map = new Map();
    for (const item of [...builtin, ...extra, ...custom]) {
      if (!map.has(item.id)) map.set(item.id, item);
    }
    items = [...map.values()];
  }
  rebuild();

  async function load() {
    if (!file) return items;
    try {
      const fsp = await import('node:fs/promises');
      const raw = await fsp.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.items) ? parsed.items : [];
      custom = list.filter((item) => isValidStickerId(item?.id)).map(enrich);
      rebuild();
      if (custom.length) logger?.info('sticker catalog loaded', { file, count: custom.length });
    } catch {
      logger?.debug('chưa có sticker catalog riêng', { file });
    }
    return items;
  }

  async function save() {
    if (!file) return;
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const payload = JSON.stringify(
      { updatedAt: new Date().toISOString(), items: custom.map(({ id, name, tags }) => ({ id, name, tags })) },
      null,
      2,
    );
    await fsp.writeFile(file, payload, 'utf8');
  }

  /** @param {{id: string, name?: string, tags?: string[]}} input */
  async function add(input) {
    if (!isValidStickerId(input.id)) throw new Error('Sticker ID phải là 20 ký tự hex');
    const id = String(input.id).toLowerCase();
    const existing = items.find((item) => item.id === id);
    if (existing) return { item: existing, added: false };
    const item = enrich({ ...input, id });
    custom = [...custom, item];
    rebuild();
    await save();
    return { item, added: true };
  }

  /** @param {string} query */
  async function remove(query) {
    const needle = normalizeText(query);
    const index = custom.findIndex(
      (item) => item.id.toLowerCase() === String(query).trim().toLowerCase() || normalizeText(item.name) === needle,
    );
    if (index < 0) return null;
    const [removed] = custom.splice(index, 1);
    rebuild();
    await save();
    return removed;
  }

  function list() {
    return items;
  }

  /** @param {string} query */
  function find(query) {
    const needle = normalizeText(query);
    if (!needle) return null;
    const byId = items.find((item) => item.id.toLowerCase() === String(query).trim().toLowerCase());
    if (byId) return byId;
    const byExactTag = items.find((item) => item.tags.some((tag) => normalizeText(tag) === needle));
    if (byExactTag) return byExactTag;
    const byName = items.find((item) => normalizeText(item.name).includes(needle));
    if (byName) return byName;
    return items.find((item) => item.tags.some((tag) => normalizeText(tag).includes(needle))) ?? null;
  }

  function random() {
    return items[Math.floor(Math.random() * items.length)] ?? null;
  }

  return { load, list, find, random, add, remove, size: () => items.length, custom: () => custom };
}
