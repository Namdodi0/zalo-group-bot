import dns from 'node:dns/promises';
import net from 'node:net';

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

/**
 * Block internal/loopback/link-local addresses so image URLs from search results are
 * not usable as an SSRF stepping stone (cloud metadata, ops server 127.0.0.1, LAN...).
 * @param {string} address
 */
export function isPrivateAddress(address) {
  const value = String(address ?? '').trim().toLowerCase();
  const family = net.isIP(value);
  if (family === 4) {
    const octets = value.split('.').map(Number);
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18/15
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (family === 6) {
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7));
    if (value.startsWith('fc') || value.startsWith('fd')) return true; // fc00::/7
    if (/^fe[89ab]/.test(value)) return true; // fe80::/10
    return false;
  }
  return false;
}

/**
 * Check an image URL before sending it to Zalo / passing it to the VL model.
 * Zalo `sendPhoto` needs a public URL; the VL model must be able to download the image too.
 * @param {{fetchImpl?: typeof fetch, lookup?: (hostname: string) => Promise<string[]>, logger?: import('../logger.js').Logger, ttlMs?: number, failTtlMs?: number, timeoutMs?: number, maxBytes?: number, now?: () => number}} [options]
 */
export function createImageValidator(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger;
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const failTtlMs = options.failTtlMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 6000;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const now = options.now ?? (() => Date.now());
  const lookupHost =
    options.lookup ?? (async (hostname) => (await dns.lookup(hostname, { all: true })).map((item) => item.address));

  /** @param {URL} url */
  async function assertPublicUrl(url) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) {
      if (isPrivateAddress(host)) throw new Error(`internal address blocked (${host})`);
      return;
    }
    const addresses = await lookupHost(host);
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        throw new Error(`hostname resolves to an internal address (${host} → ${address})`);
      }
    }
  }

  /** @type {Map<string, {ok: boolean, reason?: string, contentType?: string, bytes?: number, expires: number}>} */
  const cache = new Map();

  /** @param {string} url */
  function cached(url) {
    const hit = cache.get(url);
    if (!hit) return null;
    if (hit.expires <= now()) {
      cache.delete(url);
      return null;
    }
    return hit;
  }

  /**
   * Follow redirects manually (at most 3 hops) to check every destination — `redirect: 'follow'`
   * would jump straight into an internal host without any check.
   * @param {string} url
   * @param {'HEAD'|'GET'} method
   * @param {Record<string,string>} [headers]
   */
  async function request(url, method, headers = {}) {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!/^https?:$/.test(current.protocol)) {
        throw new Error(`unsupported protocol (${current.protocol})`);
      }
      await assertPublicUrl(current);
      const response = await fetchImpl(current.toString(), {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const location = response.headers.get('location');
      if (!REDIRECT_STATUS.has(response.status) || !location) return response;
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      current = new URL(location, current);
    }
    throw new Error('too many redirects');
  }

  /**
   * @param {string} url
   * @returns {Promise<{ok: boolean, reason?: string, contentType?: string, bytes?: number}>}
   */
  async function check(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, reason: 'invalid URL' };
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      return { ok: false, reason: `unsupported protocol (${parsed.protocol})` };
    }
    try {
      await assertPublicUrl(parsed);
    } catch (error) {
      return { ok: false, reason: String(/** @type {any} */ (error)?.message ?? error) };
    }

    /** @type {Response|null} */
    let response = null;
    let usedHead = false;

    try {
      response = await request(url, 'HEAD');
      usedHead = true;
      if (!response.ok && [400, 403, 405, 501].includes(response.status)) {
        response = await request(url, 'GET', { Range: 'bytes=0-1' });
        usedHead = false;
      }
    } catch (error) {
      logger?.debug('image HEAD failed, trying GET', { url, error: String(error) });
      try {
        response = await request(url, 'GET', { Range: 'bytes=0-1' });
        usedHead = false;
      } catch (error2) {
        return { ok: false, reason: `failed to fetch image (${String(/** @type {any} */ (error2)?.message ?? error2)})` };
      }
    }

    if (!response) return { ok: false, reason: 'no response' };
    if (!response.ok && response.status !== 206) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType && !contentType.startsWith('image/')) {
      return { ok: false, reason: `content-type is not an image (${contentType.split(';')[0]})` };
    }
    if (!contentType && !/\.(png|jpe?g|gif|webp|bmp)$/i.test(parsed.pathname)) {
      return { ok: false, reason: 'could not determine the image format' };
    }

    // With a ranged GET, content-length is only 2 bytes → read the total size from content-range.
    let bytes;
    const rangeHeader = response.headers.get('content-range');
    if (rangeHeader) {
      const total = Number(rangeHeader.split('/').pop());
      if (Number.isFinite(total)) bytes = total;
    }
    if (bytes === undefined) {
      const lengthHeader = response.headers.get('content-length');
      const parsedLength = lengthHeader ? Number(lengthHeader) : undefined;
      if (parsedLength !== undefined && Number.isFinite(parsedLength)) {
        // a 0-1 range always returns 2 bytes → do not use it to conclude the size
        bytes = !usedHead && parsedLength <= 2 ? undefined : parsedLength;
      }
    }
    if (bytes !== undefined && bytes > maxBytes) {
      return { ok: false, reason: `image too large (${bytes} bytes)` };
    }

    try {
      await response.body?.cancel();
    } catch {
      // ignore
    }

    return { ok: true, contentType: contentType || undefined, bytes };
  }

  /** @param {string} url */
  async function validate(url) {
    const key = String(url ?? '').trim();
    if (!key) return { ok: false, reason: 'empty URL' };
    const hit = cached(key);
    if (hit) return hit;

    const result = await check(key);
    cache.set(key, { ...result, expires: now() + (result.ok ? ttlMs : failTtlMs) });
    if (cache.size > 500) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return result;
  }

  return { validate, size: () => cache.size };
}
