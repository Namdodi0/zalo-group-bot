import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

/**
 * Expand an IPv6 address into 8 hextets (embedded IPv4 is converted).
 * @param {string} value
 * @returns {number[]|null}
 */
function ipv6Hextets(value) {
  let text = String(value ?? '').split('%')[0].toLowerCase();
  const embedded = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embedded) {
    const parts = embedded[1].split('.').map(Number);
    if (parts.some((part) => part > 255)) return null;
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    text = `${text.slice(0, -embedded[1].length)}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const hextets = [...left, ...Array(missing).fill('0'), ...right];
  if (hextets.length !== 8) return null;
  const parsed = hextets.map((part) => (/^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : NaN));
  return parsed.some((part) => !Number.isFinite(part)) ? null : parsed;
}

/** @param {number} hi @param {number} lo */
function embeddedIpv4(hi, lo) {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * Block internal/loopback/link-local addresses so image URLs from search results are
 * not usable as an SSRF stepping stone (cloud metadata, ops server 127.0.0.1, LAN...).
 * IPv6 is expanded so IPv4-mapped (::ffff:7f00:1), NAT64, 6to4 and Teredo forms cannot
 * bypass the IPv4 checks.
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
    const hextets = ipv6Hextets(value);
    if (!hextets) return false;
    const [a, b, c, d, e, f, g, h] = hextets;
    const zeroPrefix = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
    // IPv4-mapped ::ffff:0:0/96 — judge by the embedded IPv4 address.
    if (zeroPrefix && f === 0xffff) return isPrivateAddress(embeddedIpv4(g, h));
    // ::/96 covers the unspecified address, ::1 and the deprecated IPv4-compatible forms.
    if (zeroPrefix && f === 0) return true;
    // NAT64 well-known prefix 64:ff9b::/96 wraps an IPv4 address.
    if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
      return isPrivateAddress(embeddedIpv4(g, h));
    }
    // 6to4 2002::/16 embeds the IPv4 address in hextets 1-2.
    if (a === 0x2002) return isPrivateAddress(embeddedIpv4(b, c));
    // Teredo 2001::/32 tunnels over UDP — always block it.
    if (a === 0x2001 && b === 0) return true;
    if (hextets.every((part) => part === 0)) return true; // ::
    if (hextets.slice(0, 7).every((part) => part === 0) && h === 1) return true; // ::1
    if ((a & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
    if ((a & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((a & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
    if ((a & 0xff00) === 0xff00) return true; // multicast ff00::/8
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
  const customFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : null;
  const logger = options.logger;
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const failTtlMs = options.failTtlMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 6000;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const now = options.now ?? (() => Date.now());
  const lookupHost =
    options.lookup ?? (async (hostname) => (await dns.lookup(hostname, { all: true })).map((item) => item.address));

  /**
   * Resolve a URL host to public addresses (throws when it is internal).
   * @param {URL} url
   * @returns {Promise<string[]>}
   */
  async function resolvePublic(url) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) {
      if (isPrivateAddress(host)) throw new Error(`internal address blocked (${host})`);
      return [host];
    }
    const addresses = await lookupHost(host);
    if (!addresses.length) throw new Error(`could not resolve (${host})`);
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        throw new Error(`hostname resolves to an internal address (${host} → ${address})`);
      }
    }
    return addresses;
  }

  /**
   * Read only the response head, pinning the socket to the addresses we already validated
   * (closes the DNS-rebinding window between the check and the request).
   * @param {URL} url
   * @param {'HEAD'|'GET'} method
   * @param {Record<string,string>} headers
   * @param {string[]} addresses
   */
  function pinnedRequest(url, method, headers, addresses) {
    return new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        url,
        {
          method,
          headers,
          lookup: (hostname, options_, callback) => {
            const list = addresses.map((address) => ({ address, family: net.isIP(address) }));
            const wantsAll = Boolean(/** @type {any} */ (options_)?.all);
            if (wantsAll) callback(null, /** @type {any} */ (list));
            else callback(null, list[0].address, list[0].family);
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const headerMap = response.headers;
          // Only the head is needed: drop the socket instead of downloading the image.
          response.on('error', () => {});
          response.destroy();
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: {
              get: (name) => {
                const value = headerMap[String(name).toLowerCase()];
                return Array.isArray(value) ? value.join(', ') : (value ?? null);
              },
            },
            body: { cancel: async () => {} },
          });
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
      req.on('error', reject);
      req.end();
    });
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
      const addresses = await resolvePublic(current);
      const response = customFetch
        ? await customFetch(current.toString(), {
            method,
            headers,
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs),
          })
        : await pinnedRequest(current, method, headers, addresses);
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
      await resolvePublic(parsed);
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
