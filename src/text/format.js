/** @param {string} value */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {string} text */
export function normalizeWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Remove "@Bot deepseek" from group message content.
 * A bot name without '@' is only removed at the start of a sentence followed by ':'
 * or ',' (avoiding clipping sentences like "What is Bot deepseek?").
 * @param {string} text
 * @param {string[]} names bot names (display_name / config)
 */
export function stripMention(text, names = []) {
  let out = normalizeWhitespace(text);
  for (const name of names) {
    const clean = String(name ?? '').trim();
    if (!clean) continue;
    out = out.replace(new RegExp(`@\\s*${escapeRegExp(clean)}`, 'giu'), ' ');
    out = out.replace(new RegExp(`^\\s*${escapeRegExp(clean)}\\s*[:,]\\s*`, 'iu'), '');
  }
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[\s,;:\-–—]+/u, '')
    .trim();
}

/**
 * @param {string} value
 * @param {number} limit
 */
function hardSplit(value, limit) {
  /** @type {string[]} */
  const out = [];
  let rest = value;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(' ', limit);
    if (cut < Math.floor(limit * 0.6)) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Make sure a code fence is not opened in this chunk and left unclosed.
 * @param {string[]} chunks
 */
function balanceFences(chunks) {
  /** @type {string[]} */
  const out = [];
  let reopen = false;
  for (const original of chunks) {
    let chunk = reopen ? `\`\`\`\n${original}` : original;
    const fences = (chunk.match(/```/g) ?? []).length;
    const odd = fences % 2 === 1;
    if (odd) {
      chunk = `${chunk}\n\`\`\``;
      reopen = true;
    } else {
      reopen = false;
    }
    out.push(chunk);
  }
  return out;
}

/**
 * @param {string} block
 * @param {number} limit
 * @returns {string[]}
 */
function splitLongBlock(block, limit) {
  const lines = block.split('\n');
  if (lines.length > 1) {
    /** @type {string[]} */
    const out = [];
    let current = '';
    for (const line of lines) {
      if (line.length > limit) {
        if (current) {
          out.push(current);
          current = '';
        }
        out.push(...hardSplit(line, limit));
        continue;
      }
      const sep = current ? '\n' : '';
      if (current.length + sep.length + line.length <= limit) {
        current += sep + line;
      } else {
        out.push(current);
        current = line;
      }
    }
    if (current) out.push(current);
    return out;
  }

  /** @type {string[]} */
  const out = [];
  let current = '';
  const pieces = block.split(/(?<=[.!?…:;])\s+/u);
  for (const piece of pieces) {
    if (!piece) continue;
    if (piece.length > limit) {
      if (current) {
        out.push(current);
        current = '';
      }
      out.push(...hardSplit(piece, limit));
      continue;
    }
    const sep = current ? ' ' : '';
    if (current.length + sep.length + piece.length <= limit) {
      current += sep + piece;
    } else {
      out.push(current);
      current = piece;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Split text into multiple Zalo messages (each message <= limit characters).
 * @param {string} text
 * @param {{limit?: number, maxChunks?: number}} [options]
 * @returns {{chunks: string[], truncated: boolean}}
 */
export function chunkText(text, options = {}) {
  const limit = options.limit ?? 1900;
  const maxChunks = options.maxChunks ?? Number.POSITIVE_INFINITY;
  const normalized = normalizeWhitespace(text);
  if (!normalized) return { chunks: [], truncated: false };
  if (normalized.length <= limit) return { chunks: [normalized], truncated: false };

  /** @type {string[]} */
  const raw = [];
  let current = '';
  const pushCurrent = () => {
    if (current.trim()) raw.push(current.trim());
    current = '';
  };

  for (const block of normalized.split(/\n{2,}/)) {
    if (block.length <= limit) {
      const sep = current ? '\n\n' : '';
      if (current.length + sep.length + block.length <= limit) {
        current += sep + block;
      } else {
        pushCurrent();
        current = block;
      }
      continue;
    }
    pushCurrent();
    raw.push(...splitLongBlock(block, limit));
  }
  pushCurrent();

  /** @type {string[]} */
  const chunks = [];
  for (const item of raw) {
    if (item.length <= limit) chunks.push(item);
    else chunks.push(...hardSplit(item, limit));
  }

  const balanced = balanceFences(chunks);
  const truncated = balanced.length > maxChunks;
  return {
    chunks: truncated ? balanced.slice(0, maxChunks) : balanced,
    truncated,
  };
}

/**
 * Zalo only supports a small markdown subset: convert links/images/tables to plain text.
 * @param {string} text
 */
export function sanitizeZaloMarkdown(text) {
  let out = String(text ?? '');
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_match, alt, url) => (alt ? `${alt} (${url})` : url));
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_match, label, url) => `${label} (${url})`);
  out = out
    .split('\n')
    .filter((line) => {
      const isTable = line.includes('|');
      if (!isTable) return true;
      return !/^\s*\|?[\s|:\-]*-{2,}[\s|:\-]*\|?\s*$/.test(line);
    })
    .map((line) => {
      if (!line.includes('|')) return line;
      if (!/^\s*\|.*\|\s*$/.test(line) && (line.match(/\|/g) ?? []).length < 2) return line;
      return line
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(' · ');
    })
    .join('\n');
  out = out.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '———');
  return normalizeWhitespace(out);
}

/**
 * @param {string} text
 * @param {number} limit
 * @param {string} [suffix]
 */
export function truncate(text, limit, suffix = '…') {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  if (limit <= suffix.length) return value.slice(0, limit);
  return `${value.slice(0, limit - suffix.length).trimEnd()}${suffix}`;
}

/** @param {number} ms */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

/**
 * Prepare the final text to send to Zalo.
 * @param {string} text
 * @param {{parseMode?: 'markdown'|'none'}} [options]
 */
export function prepareOutgoing(text, options = {}) {
  let out = normalizeWhitespace(String(text ?? ''));
  if (options.parseMode !== 'none') out = sanitizeZaloMarkdown(out);
  return out;
}

/**
 * Format the date and time in Vietnam time for the system prompt.
 * @param {Date} [date]
 */
export function formatNow(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Bangkok',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return formatter.format(date);
}
