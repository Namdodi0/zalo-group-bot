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
    // SEARCH_AUTO=off → model không tự tìm web, nhưng /search vẫn dùng được.
    if (config.search.enabled && config.search.auto) {
      tools.push({
        type: 'function',
        function: {
          name: 'web_search',
          description:
            'Tìm kiếm web để lấy thông tin thời gian thực (tin tức, giá cả, thời tiết, sự kiện, sản phẩm). Trả về danh sách tiêu đề + URL + đoạn trích.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Truy vấn tìm kiếm, nên viết bằng tiếng Việt và ngắn gọn' },
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
          description: 'Tìm và gửi một ảnh vào cuộc trò chuyện hiện tại. Dùng khi người dùng xin ảnh/hình.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Từ khoá ảnh cần tìm, ví dụ "mèo con dễ thương"' },
              caption: { type: 'string', description: 'Chú thích ngắn cho ảnh (tuỳ chọn)' },
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
            'Gửi một sticker Zalo phù hợp cảm xúc/ngữ cảnh (chào, vui, buồn, cảm ơn, sinh nhật, mèo...). Dùng khi người dùng muốn phản ứng bằng sticker.',
          parameters: {
            type: 'object',
            properties: {
              emotion: {
                type: 'string',
                description: 'Cảm xúc hoặc tên gói sticker, ví dụ "chào", "vui", "mèo", "sinh nhật"',
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
    return { ok: false, text: `Công cụ không tồn tại: ${name}` };
  }

  /**
   * @param {any} args
   * @param {{chatId: string, deadline?: number}} [ctx]
   */
  async function webSearch(args, ctx = { chatId: '' }) {
    if (!config.search.enabled || !tavily) {
      return { ok: false, text: 'Web search đang tắt.' };
    }
    if (ctx.deadline && Date.now() > ctx.deadline) {
      return { ok: false, text: 'Hết thời gian xử lý trước khi kịp tìm web.' };
    }
    const query = String(args?.query ?? '').trim().slice(0, 300);
    if (!query) return { ok: false, text: 'Thiếu từ khoá tìm kiếm.' };
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
      return { ok: true, text: `Kết quả web_search cho "${query}":\n\n${text}`, data };
    } catch (error) {
      logger.warn('web_search failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
      return { ok: false, text: `Web search lỗi: ${String(/** @type {any} */ (error)?.message ?? error)}` };
    }
  }

  /**
   * @param {any} args
   * @param {{chatId: string, deadline?: number}} ctx
   */
  async function sendImage(args, ctx) {
    if (!config.image.enabled) return { ok: false, text: 'Tính năng gửi ảnh đang tắt.' };
    if (!tavily) return { ok: false, text: 'Cần Tavily để tìm ảnh.' };
    if (ctx.deadline && Date.now() > ctx.deadline) {
      return { ok: false, text: 'Hết thời gian xử lý trước khi kịp tìm ảnh.' };
    }
    const query = String(args?.query ?? '').trim().slice(0, 200);
    if (!query) return { ok: false, text: 'Thiếu từ khoá ảnh.' };

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
        return { ok: true, text: `Đã gửi ảnh "${query}" cho người dùng.`, data: { url } };
      }

      metrics?.inc('tool.sendImage.fail');
      return { ok: false, text: 'Không tìm được ảnh hợp lệ để gửi.' };
    } catch (error) {
      logger.warn('send_image failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
      return { ok: false, text: `Gửi ảnh lỗi: ${String(/** @type {any} */ (error)?.message ?? error)}` };
    }
  }

  /**
   * @param {any} args
   * @param {{chatId: string, deadline?: number}} ctx
   */
  async function sendSticker(args, ctx) {
    if (!config.sticker.enabled) return { ok: false, text: 'Tính năng sticker đang tắt.' };
    if (!stickers) return { ok: false, text: 'Chưa có catalog sticker.' };
    if (ctx.deadline && Date.now() > ctx.deadline) {
      return { ok: false, text: 'Hết thời gian xử lý trước khi kịp gửi sticker.' };
    }
    const query = String(args?.emotion ?? args?.query ?? '').trim();
    const item = (query && stickers.find(query)) || stickers.random();
    if (!item) return { ok: false, text: 'Không tìm được sticker phù hợp.' };

    try {
      await zalo.sendSticker(ctx.chatId, item.id);
      metrics?.inc('tool.sendSticker.ok');
      logger.info('sticker sent', { name: item.name, id: item.id, icon: '🧩' });
      return { ok: true, text: `Đã gửi sticker "${item.name}".` };
    } catch (error) {
      metrics?.inc('tool.sendSticker.fail');
      logger.warn('send_sticker failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
      return { ok: false, text: `Gửi sticker lỗi: ${String(/** @type {any} */ (error)?.message ?? error)}` };
    }
  }

  return { definitions, run };
}
