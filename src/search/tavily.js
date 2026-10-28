/**
 * @param {any[]} results
 * @param {{maxChars?: number, maxItems?: number}} [options]
 */
export function formatSearchResults(results, options = {}) {
  const maxChars = options.maxChars ?? 500;
  const maxItems = options.maxItems ?? 4;
  const items = (Array.isArray(results) ? results : []).slice(0, maxItems);
  if (!items.length) return '(no results)';
  return items
    .map((item, index) => {
      const title = String(item?.title ?? '').trim() || '(no title)';
      const url = String(item?.url ?? '').trim();
      const content = String(item?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
      return `${index + 1}. ${title}\n   ${url}\n   ${content}`;
    })
    .join('\n\n');
}

/**
 * @param {{apiKey: string, baseUrl?: string, http: ReturnType<typeof import('../http.js').createHttp>, logger?: import('../logger.js').Logger, metrics?: any, cacheTtlMs?: number, cacheSize?: number, now?: () => number}} options
 */
export function createTavilyClient(options) {
  const apiKey = options.apiKey;
  const baseUrl = (options.baseUrl ?? 'https://api.tavily.com').replace(/\/+$/, '');
  const http = options.http;
  const logger = options.logger;
  const metrics = options.metrics;
  const ttlMs = options.cacheTtlMs ?? 10 * 60_000;
  const cacheSize = options.cacheSize ?? 100;
  const now = options.now ?? (() => Date.now());

  /** @type {Map<string, {expires: number, data: any}>} */
  const cache = new Map();

  /** @param {string} key */
  function readCache(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expires <= now()) {
      cache.delete(key);
      return null;
    }
    return hit.data;
  }

  /** @param {string} key @param {any} data */
  function writeCache(key, data) {
    cache.set(key, { expires: now() + ttlMs, data });
    if (cache.size > cacheSize) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  /**
   * @param {string} query
   * @param {{searchDepth?: string, maxResults?: number, includeImages?: boolean, includeImageDescriptions?: boolean, topic?: string, includeAnswer?: boolean, country?: string, timeoutMs?: number}} [opts]
   */
  async function search(query, opts = {}) {
    const clean = String(query ?? '').trim().slice(0, 300);
    if (!clean) throw new Error('empty query');

    const depth = opts.searchDepth ?? 'fast';
    /** @type {Record<string, unknown>} */
    const body = {
      query: clean,
      search_depth: depth,
      max_results: opts.maxResults ?? 4,
      include_images: Boolean(opts.includeImages),
      include_image_descriptions: Boolean(opts.includeImageDescriptions),
      include_answer: Boolean(opts.includeAnswer),
      topic: opts.topic ?? 'general',
    };
    // Tavily: `country` is only supported with basic/advanced, not fast/ultra-fast.
    const country = opts.country ?? 'vietnam';
    if (country && !['fast', 'ultra-fast'].includes(String(depth))) {
      body.country = country;
    }
    const key = JSON.stringify(body);
    const cached = readCache(key);
    if (cached) {
      metrics?.inc('tavily.cacheHit');
      return cached;
    }

    const response = await http.requestJson(`${baseUrl}/search`, {
      service: 'tavily',
      label: 'search',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs ?? 9000,
      // No retry: a search that already ran may be billed twice by Tavily.
      retries: 0,
    });

    const data = /** @type {any} */ (response.data) ?? {};
    const normalized = {
      query: data.query ?? clean,
      answer: data.answer ?? '',
      results: Array.isArray(data.results) ? data.results : [],
      images: Array.isArray(data.images) ? data.images : [],
      responseTime: Number(data.response_time) || 0,
      usage: data.usage ?? null,
    };
    metrics?.inc('tavily.search');
    metrics?.inc('tavily.credits', Number(data?.usage?.credits) || 1);
    logger?.debug('tavily search', {
      query: clean,
      results: normalized.results.length,
      images: normalized.images.length,
      ms: response.latencyMs,
      icon: '🔍',
    });
    writeCache(key, normalized);
    return normalized;
  }

  return { search, cacheSize: () => cache.size };
}
