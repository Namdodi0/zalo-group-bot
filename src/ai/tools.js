import { formatSearchResults } from '../search/tavily.js';

/**
 * @param {{config: any, tavily: ReturnType<typeof import('../search/tavily.js').createTavilyClient>|null, zalo: ReturnType<typeof import('../zalo/client.js').createZaloClient>, validator: ReturnType<typeof import('../media/validate.js').createImageValidator>, stickers?: ReturnType<typeof import('./stickers.js').createStickerStore>, logger: import('../logger.js').Logger, metrics?: any}} options
 */
export function createToolRuntime(options) {
  const config = options.config;
  const tavily = options.tavily;
  const zalo = options.zalo;
  const validator = options.validator;
  const stickers = options.stickers;
  const logger = options.logger;
  const metrics = options.metrics;

  function definitions() {
    /** @type {any[]} */
    const tools = [];
    // SEARCH_AUTO=off → the model does not search the web on its own, but /search still works.
    if (config.search.enabled && config.search.auto) {
      tools.push({
        type: 'function',
        function: {
          name: 'web_search',
          description:
            'Search the web for real-time information (news, prices, weather, events, products). Returns a list of titles + URLs + snippets.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query; keep it short and natural' },
            },
            required: ['query'],
          },
        },
      });
    }
    if (config.image.enabled) {
      tools.push({
        type: 'function',
        function: {
          name: 'send_image',
          description: 'Find and send an image into the current conversation. Use when the user asks for a picture.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Image keywords to search for, e.g. "cute kitten"' },
              caption: { type: 'string', description: 'Short caption for the image (optional)' },
            },
            required: ['query'],
          },
        },
      });
    }
    if (config.sticker.enabled) {
      tools.push({
        type: 'function',
        function: {
          name: 'send_sticker',
          description:
            'Send a Zalo sticker that fits the mood/context (greeting, happy, sad, thanks, birthday, cat...). Use when the user wants to react with a sticker.',
          parameters: {
            type: 'object',
            properties: {
              emotion: {
                type: 'string',
                description: 'Mood or sticker pack name, e.g. "greeting", "happy", "cat", "birthday"',
              },
            },
            required: ['emotion'],
          },
        },
      });
    }
    return tools;
  }

  /**
   * @param {string} name
   * @param {any} args
   * @param {{chatId: string, deadline?: number}} ctx
   * @returns {Promise<{ok: boolean, text: string, data?: any}>}
   */
  async function run(name, args, ctx) {
    if (name === 'web_search') return webSearch(args, ctx);
    if (name === 'send_image') return sendImage(args, ctx);
    if (name === 'send_sticker') return sendSticker(args, ctx);
    return { ok: false, text: `Tool does not exist: ${name}` };
  }

  /**
   * @param {any} args
   * @param {{chatId: string, deadline?: number}} [ctx]
   */
  async function webSearch(args, ctx = { chatId: '' }) {
    if (!config.search.enabled || !tavily) {
      return { ok: false, text: 'Web search is disabled.' };
    }
    if (ctx.deadline && Date.now() > ctx.deadline) {
      return { ok: false, text: 'Ran out of time before the web search could run.' };
    }
    const query = String(args?.query ?? '').trim().slice(0, 300);
    if (!query) return { ok: false, text: 'Missing search keywords.' };
    try {
      const data = await tavily.search(query, {
        searchDepth: config.search.depth,
        maxResults: config.search.maxResults,
        country: config.search.country,
        timeoutMs: ctx.deadline ? Math.max(1500, Math.min(9000, ctx.deadline - Date.now())) : undefined,
      });
      metrics?.inc('tool.webSearch');
      logger.info('web search', { query, results: data.results.length, icon: '🔍' });
      const text = formatSearchResults(data.results, {
        maxChars: 500,
        maxItems: config.search.maxResults,
      });
      return { ok: true, text: `web_search results for "${query}":\n\n${text}`, data };
    } catch (error) {
      logger.warn('web_search failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
      return { ok: false, text: `Web search error: ${String(/** @type {any} */ (error)?.message ?? error)}` };
    }
  }

  /**
   * @param {any} args
   * @param {{chatId: string, deadline?: number}} ctx
   */
  async function sendImage(args, ctx) {
    if (!config.image.enabled) return { ok: false, text: 'Image sending is disabled.' };
    if (!tavily) return { ok: false, text: 'Tavily is required to search for images.' };
    if (ctx.deadline && Date.now() > ctx.deadline) {
      return { ok: false, text: 'Ran out of time before the image search could run.' };
    }
    const query = String(args?.query ?? '').trim().slice(0, 200);
    if (!query) return { ok: false, text: 'Missing image keywords.' };

    try {
      const data = await tavily.search(query, {
        searchDepth: 'fast',
        maxResults: 3,
        includeImages: true,
        country: config.search.country,
        timeoutMs: ctx.deadline ? Math.max(1500, Math.min(9000, ctx.deadline - Date.now())) : undefined,
      });

      /** @type {string[]} */
      const urls = [];
      for (const image of data.images) {
        urls.push(typeof image === 'string' ? image : image?.url);
      }
      for (const result of data.results) {
        for (const image of result?.images ?? []) {
          urls.push(typeof image === 'string' ? image : image?.url);
        }
      }
      const unique = [...new Set(urls.filter((url) => typeof url === 'string' && url.startsWith('http')))].slice(0, 3);
      const deadline = ctx.deadline ?? Date.now() + 30_000;

      for (const url of unique) {
        if (Date.now() > deadline) break;
        const check = await validator.validate(url);
        if (!check.ok) {
          logger.debug('image rejected by validator', { url, reason: check.reason, icon: '🚫' });
          continue;
        }
        if (Date.now() > deadline) break;
        const caption = String(args?.caption ?? '').trim() || query;
        await zalo.sendPhoto(ctx.chatId, url, caption);
        metrics?.inc('tool.sendImage.ok');
        logger.info('image sent', { query, url, icon: '🖼️' });
        return { ok: true, text: `Sent the image "${query}" to the user.`, data: { url } };
      }

      metrics?.inc('tool.sendImage.fail');
      return { ok: false, text: 'Could not find a valid image to send.' };
    } catch (error) {
      logger.warn('send_image failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
      return { ok: false, text: `Failed to send image: ${String(/** @type {any} */ (error)?.message ?? error)}` };
    }
  }

  /**
   * @param {any} args
   * @param {{chatId: string, deadline?: number}} ctx
   */
  async function sendSticker(args, ctx) {
    if (!config.sticker.enabled) return { ok: false, text: 'Stickers are disabled.' };
    if (!stickers) return { ok: false, text: 'No sticker catalog yet.' };
    if (ctx.deadline && Date.now() > ctx.deadline) {
      return { ok: false, text: 'Ran out of time before the sticker could be sent.' };
    }
    const query = String(args?.emotion ?? args?.query ?? '').trim();
    const item = (query && stickers.find(query)) || stickers.random();
    if (!item) return { ok: false, text: 'Could not find a matching sticker.' };

    try {
      await zalo.sendSticker(ctx.chatId, item.id);
      metrics?.inc('tool.sendSticker.ok');
      logger.info('sticker sent', { name: item.name, id: item.id, icon: '🧩' });
      return { ok: true, text: `Sent the sticker "${item.name}".` };
    } catch (error) {
      metrics?.inc('tool.sendSticker.fail');
      logger.warn('send_sticker failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
      return { ok: false, text: `Failed to send sticker: ${String(/** @type {any} */ (error)?.message ?? error)}` };
    }
  }

  return { definitions, run };
}
