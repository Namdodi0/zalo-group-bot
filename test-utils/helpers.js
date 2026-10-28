import { createSilentLogger } from '../src/logger.js';

export const silentLogger = createSilentLogger();

/**
 * Cấu hình tối thiểu dùng cho test agent/commands.
 * @param {Record<string, any>} [overrides]
 */
export function makeConfig(overrides = {}) {
  const base = {
    help: false,
    token: 'test-token',
    zalo: {
      token: 'test-token',
      botId: '',
      baseUrl: 'https://bot-api.zaloplatforms.com',
      parseMode: 'markdown',
    },
    allowedChatIds: [],
    adminIds: [],
    mode: 'polling',
    webhook: { port: 8787, host: '127.0.0.1', path: '/zalo/webhook', secret: 'secret-1234', publicUrl: '' },
    nim: {
      apiKey: 'test-nim-key',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
      ultraModel: 'nvidia/nemotron-3-ultra-550b-a55b',
      fallbackModel: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      temperature: 0.6,
      timeoutMs: 5000,
    },
    deepseek: {
      apiKey: 'test-deepseek-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      proModel: 'deepseek-v4-pro',
      temperature: 0.6,
      timeoutMs: 5000,
    },
    model: { defaultAlias: 'deepseek', fallbackAlias: 'nim-light' },
    ai: { reasoning: 'none', maxTokens: null, temperature: 0.6, timeoutMs: 5000 },
    responseTimeoutMs: 8000,
    context: {
      dir: './data/test',
      maxTokens: 6000,
      maxMessages: 40,
      maxCharsPerMessage: 12000,
      ttlHours: 72,
      summary: true,
      modelWindow: 0,
      compactThreshold: 0.8,
      keepRecent: 8,
      summaryMaxChars: 1200,
      toolResultKeepChars: 600,
    },
    search: {
      enabled: true,
      auto: true,
      apiKey: 'test-tavily',
      baseUrl: 'https://api.tavily.com',
      depth: 'fast',
      maxResults: 4,
      country: 'vietnam',
      cacheTtlMs: 600000,
    },
    image: { enabled: true },
    sticker: { enabled: true, echo: true, file: './data/test/stickers.json' },
    tone: 'friendly',
    typing: false,
    typingIntervalMs: 4000,
    progressive: 'off',
    progressiveAfterMs: 3000,
    maxMessagesPerReply: 3,
    maxQueueDepth: 50,
    userRateLimitPerMinute: 0,
    logLevel: 'silent',
    dataDir: './data/test',
    opsPort: null,
    dryRun: false,
    once: false,
  };
  return {
    ...base,
    ...overrides,
    zalo: { ...base.zalo, ...(overrides.zalo ?? {}) },
    nim: { ...base.nim, ...(overrides.nim ?? {}) },
    deepseek: { ...base.deepseek, ...(overrides.deepseek ?? {}) },
    model: { ...base.model, ...(overrides.model ?? {}) },
    ai: { ...base.ai, ...(overrides.ai ?? {}) },
    context: { ...base.context, ...(overrides.context ?? {}) },
    search: { ...base.search, ...(overrides.search ?? {}) },
  };
}

/** @param {string} text */
export function textEvent(text, overrides = {}) {
  return {
    kind: 'text',
    chatId: 'chat-1',
    chatType: 'GROUP',
    senderId: 'user-1',
    senderName: 'Nam',
    isBot: false,
    text,
    imageUrl: null,
    sticker: null,
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    date: Date.now(),
    eventName: 'message.text.received',
    ...overrides,
  };
}
