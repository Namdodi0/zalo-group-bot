import { DEEPSEEK_REASONING_MAP, NIM_REASONING_MAP, createOpenAiCompatAdapter } from '../src/ai/llm/adapter-openai.js';
import { loadConfig } from '../src/config.js';
import { loadEnvFiles } from '../src/env.js';
import { createHttp } from '../src/http.js';
import { createLogger } from '../src/logger.js';
import { createImageValidator } from '../src/media/validate.js';
import { createMetrics } from '../src/metrics.js';
import { createTavilyClient } from '../src/search/tavily.js';
import { createZaloClient } from '../src/zalo/client.js';

/** @param {string} label @param {boolean} ok @param {string} detail */
function report(label, ok, detail = '') {
  const mark = ok ? 'OK  ' : 'FAIL';
  // eslint-disable-next-line no-console
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  loadEnvFiles();
  const config = loadConfig();
  const logger = createLogger({ level: 'warn', version: config.version });
  const metrics = createMetrics();
  const httpClient = createHttp({ logger, metrics });

  let failures = 0;

  // 1. Zalo getMe
  const zalo = createZaloClient({
    token: config.zalo.token,
    baseUrl: config.zalo.baseUrl,
    http: httpClient,
    logger,
    metrics,
  });
  try {
    const started = Date.now();
    const me = await zalo.getMe();
    report('Zalo getMe', true, `id=${me.id} name=${me.display_name} groups=${me.can_join_groups} ${Date.now() - started}ms`);
  } catch (error) {
    failures += 1;
    report('Zalo getMe', false, String(/** @type {any} */ (error)?.message ?? error));
  }

  // 2. DeepSeek (model chính)
  if (config.deepseek.apiKey) {
    const deepseek = createOpenAiCompatAdapter({
      provider: 'deepseek',
      apiKey: config.deepseek.apiKey,
      baseUrl: config.deepseek.baseUrl,
      model: config.deepseek.model,
      http: httpClient,
      logger,
      metrics,
      reasoningMap: DEEPSEEK_REASONING_MAP,
    });
    try {
      const started = Date.now();
      const response = await deepseek.chat({
        messages: [
          { role: 'system', content: 'Trả lời cực ngắn gọn bằng tiếng Việt.' },
          { role: 'user', content: 'Nói "xin chào" và cho biết bạn là model gì.' },
        ],
        reasoning: 'none',
        maxTokens: config.ai.maxTokens,
      });
      const usage = response.usage ?? {};
      report(
        `DeepSeek (${config.deepseek.model})`,
        Boolean(response.content),
        `${Date.now() - started}ms · prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} · ${String(response.content).replace(/\s+/g, ' ').slice(0, 100)}`,
      );
    } catch (error) {
      failures += 1;
      report(`DeepSeek (${config.deepseek.model})`, false, String(/** @type {any} */ (error)?.message ?? error));
    }
  } else {
    report('DeepSeek', true, 'bỏ qua (chưa cấu hình DEEPSEEK_API_KEY)');
  }

  // 3. NIM (model dự phòng)
  if (config.nim.apiKey) {
    const nim = createOpenAiCompatAdapter({
      provider: 'nim',
      apiKey: config.nim.apiKey,
      baseUrl: config.nim.baseUrl,
      model: config.nim.fallbackModel,
      http: httpClient,
      logger,
      metrics,
      reasoningMap: NIM_REASONING_MAP,
    });
    try {
      const started = Date.now();
      const response = await nim.chat({
        messages: [{ role: 'user', content: 'Chào bạn, trả lời 1 câu tiếng Việt.' }],
        reasoning: 'none',
      });
      report(`NIM fallback (${config.nim.fallbackModel})`, Boolean(response.content), `${Date.now() - started}ms`);
    } catch (error) {
      failures += 1;
      report(`NIM fallback (${config.nim.fallbackModel})`, false, String(/** @type {any} */ (error)?.message ?? error));
    }
  } else {
    report('NIM fallback', true, 'bỏ qua (chưa cấu hình NIM_API_KEY)');
  }

  // 4. Tavily search
  /** @type {any[]} */
  let images = [];
  if (config.search.enabled) {
    const tavily = createTavilyClient({
      apiKey: config.search.apiKey,
      baseUrl: config.search.baseUrl,
      http: httpClient,
      logger,
      metrics,
      cacheTtlMs: config.search.cacheTtlMs,
    });
    try {
      const started = Date.now();
      const data = await tavily.search('giá vàng hôm nay', {
        searchDepth: config.search.depth,
        maxResults: 3,
        includeImages: true,
        country: config.search.country,
      });
      images = data.images;
      report('Tavily search', data.results.length > 0, `${Date.now() - started}ms · ${data.results.length} kết quả · ${data.images.length} ảnh`);
      if (data.results[0]) console.log(`       ↳ ${data.results[0].title}`);
    } catch (error) {
      failures += 1;
      report('Tavily search', false, String(/** @type {any} */ (error)?.message ?? error));
    }
  } else {
    report('Tavily search', true, 'đang tắt (SEARCH_ENABLED=off)');
  }

  // 5. Image validator
  const validator = createImageValidator({ logger });
  const sample = images.find((image) => (typeof image === 'string' ? image : image?.url));
  const sampleUrl = typeof sample === 'string' ? sample : sample?.url;
  if (sampleUrl) {
    const check = await validator.validate(sampleUrl);
    report('Image validator', check.ok, check.ok ? `${check.contentType ?? 'image'}` : `${check.reason} — ${sampleUrl}`);
  } else {
    report('Image validator', true, 'bỏ qua (không có ảnh mẫu)');
  }

  console.log('');
  if (failures) {
    console.log(`${failures} mục lỗi.`);
    process.exitCode = 1;
  } else {
    console.log('Smoke test hoàn tất.');
  }
}

main().catch((error) => {
  console.error('smoke crashed:', error);
  process.exit(1);
});
