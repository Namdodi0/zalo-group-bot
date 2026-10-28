/**
 * Run the agent against real NIM/Tavily but send NO messages to Zalo.
 * Use it to check the pipeline, tool calling and context before letting the bot loose in a group.
 *
 *   npm run simulate -- "hi bot, my name is Nam"
 *   npm run simulate -- "what is the gold price today?"
 *   npm run simulate -- "/status"
 */
import path from 'node:path';
import { createAgent } from '../src/ai/agent.js';
import { DEEPSEEK_REASONING_MAP, NIM_REASONING_MAP, createOpenAiCompatAdapter } from '../src/ai/llm/adapter-openai.js';
import { createLlmService } from '../src/ai/llm/service.js';
import { createModelRouter } from '../src/ai/router.js';
import { createStickerStore } from '../src/ai/stickers.js';
import { createSummarizer } from '../src/ai/summarize.js';
import { createToolRuntime } from '../src/ai/tools.js';
import { createCommands } from '../src/commands/index.js';
import { createCompactionEngine } from '../src/context/compaction/engine.js';
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
  console.error('Usage: npm run simulate -- "question"');
  process.exit(1);
}

loadEnvFiles();

const config = loadConfig({
  // Do not parse flags from the message content (avoid "--help" inside a question).
  argv: [],
  env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' },
});
const logger = createLogger({
  level: config.logLevel,
  format: config.logFormat,
  color: config.logColor,
  version: config.version,
});
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

/** @type {any[]} */
const adapters = [];
if (config.deepseek.apiKey) {
  adapters.push(createOpenAiCompatAdapter({
    provider: 'deepseek',
    apiKey: config.deepseek.apiKey,
    baseUrl: config.deepseek.baseUrl,
    model: config.deepseek.model,
    http: httpClient,
    logger,
    metrics,
    defaultTemperature: config.deepseek.temperature,
    reasoningMap: DEEPSEEK_REASONING_MAP,
  }));
}
if (config.nim.apiKey) {
  adapters.push(createOpenAiCompatAdapter({
    provider: 'nim',
    apiKey: config.nim.apiKey,
    baseUrl: config.nim.baseUrl,
    model: config.nim.model,
    http: httpClient,
    logger,
    metrics,
    defaultTemperature: config.nim.temperature,
    reasoningMap: NIM_REASONING_MAP,
  }));
}
const service = createLlmService({ adapters, logger, metrics });
const models = createModelRouter({ config, service, logger });

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
const summarize = createSummarizer({ llm: models, logger });
const compaction = createCompactionEngine({ config, logger, metrics, summarize });
const tools = createToolRuntime({ config, tavily, zalo, validator, stickers, logger, metrics });
const commands = createCommands({
  config,
  store,
  metrics,
  zalo,
  http: httpClient,
  models,
  stickers,
  logger,
  compaction,
});
const agent = createAgent({
  config,
  logger,
  metrics,
  zalo,
  llm: models,
  store,
  tools,
  commands,
  stickers,
  http: httpClient,
  compaction,
});

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
console.log(`\n--- ${Date.now() - started}ms · ${record.turns} turns · ${record.messages.length} messages in context ---`);
await store.flush();
