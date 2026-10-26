/**
 * Chạy thử agent với NIM/Tavily thật nhưng KHÔNG gửi tin lên Zalo.
 * Dùng để kiểm tra pipeline, tool calling, context trước khi thả bot vào group.
 *
 *   npm run simulate -- "chào bot, mình tên Nam"
 *   npm run simulate -- "giá vàng hôm nay thế nào?"
 *   npm run simulate -- "/status"
 */
import path from 'node:path';
import { createAgent } from '../src/ai/agent.js';
import { DEEPSEEK_REASONING_MAP, NIM_REASONING_MAP, createLlmClient } from '../src/ai/nim.js';
import { createModelRouter } from '../src/ai/router.js';
import { createStickerStore } from '../src/ai/stickers.js';
import { createToolRuntime } from '../src/ai/tools.js';
import { createCommands } from '../src/commands/index.js';
import { loadConfig } from '../src/config.js';
import { createContextStore } from '../src/context/store.js';
import { loadEnvFiles } from '../src/env.js';
import { createHttp } from '../src/http.js';
import { createLogger } from '../src/logger.js';
import { createImageValidator } from '../src/media/validate.js';
import { createMetrics } from '../src/metrics.js';
import { createTavilyClient } from '../src/search/tavily.js';

const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('Dùng: npm run simulate -- "câu hỏi"');
  process.exit(1);
}

loadEnvFiles();

const config = loadConfig({
  // Không parse flags từ nội dung tin nhắn (tránh "--help" trong câu hỏi).
  argv: [],
  env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' },
});
const logger = createLogger({ level: config.logLevel });
const metrics = createMetrics();
const httpClient = createHttp({ logger, metrics });

const store = createContextStore({
  dir: path.join(config.dataDir, 'simulate'),
  logger,
  ttlHours: config.context.ttlHours,
});
await store.init();

/** @type {any} */
const zalo = {
  displayName: 'Bot deepseek',
  sendMessage: async (chatId, body) => {
    console.log(`\n[BOT → ${chatId}]\n${body}`);
    return { ok: true };
  },
  sendPhoto: async (chatId, url, caption) => {
    console.log(`\n[BOT → ${chatId}] 🖼️ ${url}\n${caption ?? ''}`);
    return { ok: true };
  },
  sendChatAction: async () => ({ ok: true }),
  sendSticker: async (chatId, stickerId) => {
    console.log(`\n[BOT → ${chatId}] 🧩 sticker ${stickerId}`);
    return { ok: true };
  },
  ping: async () => 0,
  startTyping: () => () => {},
  stopAllTyping: () => {},
};

/** @type {Record<string, any>} */
const clients = {};
if (config.deepseek.apiKey) {
  clients.deepseek = createLlmClient({
    provider: 'deepseek',
    apiKey: config.deepseek.apiKey,
    baseUrl: config.deepseek.baseUrl,
    model: config.deepseek.model,
    http: httpClient,
    logger,
    metrics,
    defaultTemperature: config.deepseek.temperature,
    reasoningMap: DEEPSEEK_REASONING_MAP,
  });
}
if (config.nim.apiKey) {
  clients.nim = createLlmClient({
    provider: 'nim',
    apiKey: config.nim.apiKey,
    baseUrl: config.nim.baseUrl,
    model: config.nim.model,
    http: httpClient,
    logger,
    metrics,
    defaultTemperature: config.nim.temperature,
    reasoningMap: NIM_REASONING_MAP,
  });
}
const models = createModelRouter({ config, clients, logger });

const tavily = config.search.enabled
  ? createTavilyClient({
      apiKey: config.search.apiKey,
      baseUrl: config.search.baseUrl,
      http: httpClient,
      logger,
      metrics,
    })
  : null;

const validator = createImageValidator({ logger });
const stickers = createStickerStore({ file: config.sticker.file, extraIds: config.sticker.extraIds, logger });
await stickers.load();
const tools = createToolRuntime({ config, tavily, zalo, validator, stickers, logger, metrics });
const commands = createCommands({ config, store, metrics, zalo, http: httpClient, models, stickers, logger });
const agent = createAgent({ config, logger, metrics, zalo, llm: models, store, tools, commands, stickers, http: httpClient });

const started = Date.now();
await agent.handle({
  kind: 'text',
  chatId: 'simulate-chat',
  chatType: 'GROUP',
  senderId: 'user-1',
  senderName: 'Nam',
  isBot: false,
  text,
  imageUrl: null,
  sticker: null,
  messageId: `sim-${Date.now()}`,
  date: Date.now(),
  eventName: 'message.text.received',
});

const record = await store.get('simulate-chat');
console.log(`\n--- ${Date.now() - started}ms · ${record.turns} lượt · ${record.messages.length} tin trong context ---`);
await store.flush();
