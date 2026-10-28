import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import crypto from 'node:crypto';
import { DEFAULT_ALIAS, FALLBACK_ALIAS, MODEL_ALIASES, isKnownAlias } from './ai/models.js';
import { parseStickerIds } from './ai/stickers.js';
import { VERSION } from './version.js';

/** @typedef {'polling'|'webhook'} TransportMode */
/** @typedef {'none'|'low'|'medium'|'high'|'auto'} ReasoningMode */
/** @typedef {'auto'|'on'|'off'} ProgressiveMode */

const BOOL_TRUE = new Set(['1', 'on', 'true', 'yes', 'y']);
const BOOL_FALSE = new Set(['0', 'off', 'false', 'no', 'n', '']);

// Thư mục gốc của repo, tính từ file này (src/..) — KHÔNG phụ thuộc cwd.
// Panel/pm2/systemd có thể khởi động bot với cwd khác, làm DATA_DIR tương đối
// trỏ sang một thư mục mới tinh và context "biến mất" sau mỗi lần restart.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * DATA_DIR nằm trong thư mục tạm thì chắc chắn mất khi restart/redeploy.
 * @param {string} dir
 */
export function isEphemeralDataDir(dir) {
  const normalized = String(dir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return (
    normalized === '/tmp' ||
    normalized.startsWith('/tmp/') ||
    normalized === '/var/tmp' ||
    normalized.startsWith('/var/tmp/') ||
    normalized.endsWith('/temp') ||
    normalized.includes('/temp/') ||
    normalized.includes('/appdata/local/temp')
  );
}

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** @param {Record<string, unknown>} env @param {string} key @param {boolean} fallback */
function readBool(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (BOOL_TRUE.has(value)) return true;
  if (BOOL_FALSE.has(value)) return false;
  throw new ConfigError(`${key} phải là on/off (nhận: "${raw}")`);
}

/** @param {Record<string, unknown>} env @param {string} key @param {string} fallback */
function readStr(env, key, fallback = '') {
  const raw = env[key];
  if (raw === undefined || raw === null) return fallback;
  return String(raw).trim();
}

/**
 * @param {Record<string, unknown>} env
 * @param {string} key
 * @param {number|null} fallback
 * @param {{min?:number,max?:number}} [bounds]
 * @returns {number|null}
 */
function readInt(env, key, fallback, bounds = {}) {
  const raw = readStr(env, key);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConfigError(`${key} phải là số nguyên (nhận: "${raw}")`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new ConfigError(`${key} phải >= ${bounds.min} (nhận: ${value})`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new ConfigError(`${key} phải <= ${bounds.max} (nhận: ${value})`);
  }
  return value;
}

/** @param {Record<string, unknown>} env @param {string} key */
function readList(env, key) {
  return readStr(env, key)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Rút gọn secret để in ra log/an toàn. */
export function maskSecret(value) {
  if (!value) return '(empty)';
  const text = String(value);
  if (text.length <= 10) return '***';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

/** Liệt kê các secret cần redact trong log. */
export function collectSecrets(config) {
  return [
    config.zalo.token,
    config.nim.apiKey,
    config.search.apiKey,
    config.webhook.secret,
  ].filter(Boolean);
}

/** @type {import('node:util').ParseArgsOptionsConfig} */
const CLI_OPTIONS = {
  model: { type: 'string' },
  mode: { type: 'string' },
  think: { type: 'string' },
  'max-tokens': { type: 'string' },
  'no-search': { type: 'boolean' },
  'no-typing': { type: 'boolean' },
  'no-progressive': { type: 'boolean' },
  progressive: { type: 'string' },
  verbose: { type: 'boolean' },
  json: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  once: { type: 'boolean' },
  help: { type: 'boolean' },
};

export const HELP_TEXT = `zalo-group-bot — bot Zalo cho group chat (NVIDIA NIM + Tavily)

Cách dùng: node index.js [flags]      (.env được tự nạp từ thư mục đang chạy)

Flags:
  --model <alias>     Model mặc định: deepseek | pro | nim | ultra | nim-light
  --mode <m>          polling | webhook
  --think <mode>      none | low | medium | high | auto
  --max-tokens <n>    Giới hạn số token sinh ra (bỏ trống = không giới hạn)
  --progressive <m>   auto | on | off  (gửi tách đoạn khi trả lời chậm)
  --no-progressive    Tắt gửi tách đoạn
  --no-search         Tắt web search
  --no-typing         Không gửi trạng thái "đang soạn tin"
  --dry-run           Không gửi tin nhắn thật (chỉ log)
  --once              Chỉ nhận 1 lượt update rồi thoát (để test)
  --verbose           Log mức debug
  --json              Log dạng JSON (mặc định là pretty, có màu + icon)
  --help              In trợ giúp

Biến môi trường: xem .env.example`;

/**
 * Secret webhook: ưu tiên env; nếu thiếu thì sinh 1 lần và lưu vào data/
 * để restart không làm secret đổi (tránh mọi request bị 403).
 * @param {Record<string, unknown>} env
 * @param {string} dataDir
 * @param {string} mode
 */
function resolveWebhookSecret(env, dataDir, mode) {
  const fromEnv = readStr(env, 'WEBHOOK_SECRET');
  if (fromEnv) {
    if (fromEnv.length < 8) throw new ConfigError('WEBHOOK_SECRET phải có ít nhất 8 ký tự');
    return fromEnv;
  }
  if (mode !== 'webhook') return '';

  const file = path.join(dataDir, 'webhook-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 8) return existing;
  } catch {
    // chưa có file → sinh mới bên dưới
  }

  const generated = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, generated, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // không lưu được thì vẫn dùng secret tạm cho phiên này
  }
  return generated;
}

/**
 * @param {{argv?: string[], env?: Record<string, unknown>, cwd?: string}} [input]
 */
export function loadConfig(input = {}) {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();

  const { values } = parseArgs({
    args: argv,
    options: CLI_OPTIONS,
    allowPositionals: true,
    strict: false,
  });
  const cli = /** @type {Record<string, any>} */ (values);

  if (cli.help) {
    return /** @type {any} */ ({ help: true });
  }

  const mode = String(cli.mode ?? readStr(env, 'MODE', 'polling')).toLowerCase();
  if (mode !== 'polling' && mode !== 'webhook') {
    throw new ConfigError(`MODE phải là "polling" hoặc "webhook" (nhận: "${mode}")`);
  }

  const reasoning = String(
    cli.think ?? readStr(env, 'AI_REASONING', readStr(env, 'NIM_REASONING', 'none')),
  ).toLowerCase();
  if (!['none', 'low', 'medium', 'high', 'auto'].includes(reasoning)) {
    throw new ConfigError(`AI_REASONING phải là none|low|medium|high|auto (nhận: "${reasoning}")`);
  }

  let progressive = String(
    cli['no-progressive'] ? 'off' : cli.progressive ?? readStr(env, 'PROGRESSIVE', 'auto'),
  ).toLowerCase();
  if (!['auto', 'on', 'off'].includes(progressive)) {
    throw new ConfigError(`PROGRESSIVE phải là auto|on|off (nhận: "${progressive}")`);
  }

  const logFormat = String(cli.json ? 'json' : readStr(env, 'LOG_FORMAT', 'pretty')).toLowerCase();
  if (!['pretty', 'json'].includes(logFormat)) {
    throw new ConfigError(`LOG_FORMAT phải là pretty hoặc json (nhận: "${logFormat}")`);
  }

  const logColor = readStr(env, 'LOG_COLOR', 'auto').toLowerCase();
  if (!['auto', 'always', 'never'].includes(logColor)) {
    throw new ConfigError(`LOG_COLOR phải là auto|always|never (nhận: "${logColor}")`);
  }

  const maxTokensRaw =
    cli['max-tokens'] !== undefined ? String(cli['max-tokens']) : readStr(env, 'NIM_MAX_TOKENS');
  let maxTokens = null;
  if (maxTokensRaw) {
    const parsed = Number(maxTokensRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new ConfigError(`NIM_MAX_TOKENS phải là số nguyên >= 0 hoặc để trống (nhận: "${maxTokensRaw}")`);
    }
    // 0 = không giới hạn (giống để trống)
    maxTokens = parsed === 0 ? null : parsed;
  }

  const token = readStr(env, 'ZALO_BOT_TOKEN');
  if (!token) throw new ConfigError('Thiếu ZALO_BOT_TOKEN (xem .env.example)');

  const apiKey = readStr(env, 'NIM_API_KEY');
  const deepseekKey = readStr(env, 'DEEPSEEK_API_KEY');

  const defaultAlias = String(cli.model ?? readStr(env, 'MODEL_DEFAULT', DEFAULT_ALIAS)).toLowerCase();
  if (!isKnownAlias(defaultAlias)) {
    throw new ConfigError(
      `MODEL_DEFAULT không hợp lệ (nhận: "${defaultAlias}"). Chọn: ${Object.keys(MODEL_ALIASES).join(', ')}`,
    );
  }
  let fallbackAlias = String(readStr(env, 'MODEL_FALLBACK', FALLBACK_ALIAS)).toLowerCase();
  if (!isKnownAlias(fallbackAlias)) {
    throw new ConfigError(
      `MODEL_FALLBACK không hợp lệ (nhận: "${fallbackAlias}"). Chọn: ${Object.keys(MODEL_ALIASES).join(', ')}`,
    );
  }
  if (fallbackAlias === defaultAlias) fallbackAlias = defaultAlias === 'nim-light' ? 'deepseek' : 'nim-light';

  // Chỉ bắt buộc key của provider đang được dùng (mặc định hoặc dự phòng).
  const usedProviders = new Set([
    MODEL_ALIASES[defaultAlias].provider,
    MODEL_ALIASES[fallbackAlias].provider,
  ]);
  if (usedProviders.has('nim') && !apiKey) {
    throw new ConfigError('Thiếu NIM_API_KEY (đang dùng làm model chính hoặc dự phòng)');
  }
  if (usedProviders.has('deepseek') && !deepseekKey) {
    throw new ConfigError('Thiếu DEEPSEEK_API_KEY (xem .env.example)');
  }

  const searchEnabled = cli['no-search']
    ? false
    : readBool(env, 'SEARCH_ENABLED', true);
  const tavilyKey = readStr(env, 'TAVILY_API_KEY');
  if (searchEnabled && !tavilyKey) {
    throw new ConfigError('SEARCH_ENABLED=on nhưng thiếu TAVILY_API_KEY (hoặc dùng --no-search)');
  }

  let webhookSecret = '';
  // Tương đối → resolve theo gốc repo, để cwd của panel/pm2 không đổi chỗ lưu context.
  const dataDirRaw = readStr(env, 'DATA_DIR', './data').trim() || './data';
  const dataDir = path.isAbsolute(dataDirRaw)
    ? path.normalize(dataDirRaw)
    : path.resolve(PROJECT_ROOT, dataDirRaw);
  webhookSecret = resolveWebhookSecret(env, dataDir, mode);

  const depthRaw = readStr(env, 'SEARCH_DEPTH', 'fast');
  if (!['fast', 'basic', 'advanced', 'ultra-fast'].includes(depthRaw)) {
    throw new ConfigError(`SEARCH_DEPTH phải là fast|basic|advanced|ultra-fast (nhận: "${depthRaw}")`);
  }

  const config = {
    help: false,
    version: VERSION,
    token,
    zalo: {
      token,
      botId: readStr(env, 'ZALO_BOT_ID'),
      baseUrl: readStr(env, 'ZALO_BASE_URL', 'https://bot-api.zaloplatforms.com'),
      parseMode: /** @type {'markdown'|'none'} */ (readStr(env, 'ZALO_PARSE_MODE', 'markdown') === 'none' ? 'none' : 'markdown'),
    },
    allowedChatIds: readList(env, 'ALLOWED_CHAT_IDS'),
    adminIds: readList(env, 'ADMIN_IDS'),
    mode: /** @type {TransportMode} */ (mode),
    webhook: {
      port: /** @type {number} */ (readInt(env, 'WEBHOOK_PORT', 8787, { min: 1, max: 65535 })),
      host: readStr(env, 'WEBHOOK_HOST', '127.0.0.1'),
      path: readStr(env, 'WEBHOOK_PATH', '/zalo/webhook'),
      secret: webhookSecret,
      publicUrl: readStr(env, 'WEBHOOK_PUBLIC_URL'),
    },
    nim: {
      apiKey,
      baseUrl: readStr(env, 'NIM_BASE_URL', 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
      model: readStr(env, 'NIM_MODEL', 'nvidia/nemotron-3.5-super-vl-120b-a12b'),
      ultraModel: readStr(env, 'NIM_ULTRA_MODEL', 'nvidia/nemotron-3-ultra-550b-a55b'),
      fallbackModel: readStr(env, 'NIM_FALLBACK_MODEL', 'nvidia/nemotron-3.5-lightning-30b-a3b'),
      temperature: Number(readStr(env, 'NIM_TEMPERATURE', '0.6')) || 0.6,
      timeoutMs: /** @type {number} */ (readInt(env, 'NIM_TIMEOUT_MS', 15000, { min: 1000 })),
    },
    deepseek: {
      apiKey: deepseekKey,
      baseUrl: readStr(env, 'DEEPSEEK_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
      model: readStr(env, 'DEEPSEEK_MODEL', 'deepseek-flash'),
      proModel: readStr(env, 'DEEPSEEK_PRO_MODEL', 'deepseek-v4-pro'),
      temperature: Number(readStr(env, 'DEEPSEEK_TEMPERATURE', '0.6')) || 0.6,
      timeoutMs: /** @type {number} */ (readInt(env, 'DEEPSEEK_TIMEOUT_MS', 15000, { min: 1000 })),
    },
    model: {
      defaultAlias,
      fallbackAlias,
    },
    ai: {
      reasoning: /** @type {ReasoningMode} */ (reasoning),
      maxTokens,
      temperature: Number(readStr(env, 'NIM_TEMPERATURE', '0.6')) || 0.6,
      timeoutMs: /** @type {number} */ (readInt(env, 'NIM_TIMEOUT_MS', 15000, { min: 1000 })),
    },
    responseTimeoutMs: /** @type {number} */ (readInt(env, 'RESPONSE_TIMEOUT_MS', 30000, { min: 2000 })),
    context: {
      dir: path.join(dataDir, 'contexts'),
      // 0 = không giới hạn
      maxTokens: /** @type {number} */ (readInt(env, 'CONTEXT_MAX_TOKENS', 0, { min: 0 })),
      maxMessages: /** @type {number} */ (readInt(env, 'CONTEXT_MAX_MESSAGES', 0, { min: 0 })),
      maxCharsPerMessage: /** @type {number} */ (readInt(env, 'CONTEXT_MAX_CHARS_PER_MESSAGE', 12000, { min: 0 })),
      ttlHours: /** @type {number} */ (readInt(env, 'CONTEXT_TTL_HOURS', 72, { min: 0 })),
      // ttlHours = 0 → không bao giờ tự xoá context
      summary: readBool(env, 'CONTEXT_SUMMARY', true),
      // 0 = chưa biết context window → chỉ compaction khi provider báo overflow
      modelWindow: /** @type {number} */ (readInt(env, 'CONTEXT_MODEL_WINDOW', 0, { min: 0 })),
      compactThreshold: (() => {
        const raw = readStr(env, 'CONTEXT_COMPACT_THRESHOLD');
        if (!raw) return 0.8;
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0 || value > 1) {
          throw new ConfigError(`CONTEXT_COMPACT_THRESHOLD phải trong khoảng (0, 1] (nhận: "${raw}")`);
        }
        return value;
      })(),
      keepRecent: /** @type {number} */ (readInt(env, 'CONTEXT_KEEP_RECENT', 8, { min: 1 })),
      summaryMaxChars: /** @type {number} */ (readInt(env, 'CONTEXT_SUMMARY_MAX_CHARS', 1200, { min: 100 })),
      toolResultKeepChars: /** @type {number} */ (readInt(env, 'CONTEXT_TOOL_RESULT_KEEP_CHARS', 600, { min: 0 })),
    },
    search: {
      enabled: searchEnabled,
      auto: readBool(env, 'SEARCH_AUTO', true),
      apiKey: tavilyKey,
      baseUrl: readStr(env, 'TAVILY_BASE_URL', 'https://api.tavily.com').replace(/\/+$/, ''),
      depth: /** @type {'fast'|'basic'|'advanced'|'ultra-fast'} */ (depthRaw),
      maxResults: /** @type {number} */ (readInt(env, 'SEARCH_MAX_RESULTS', 4, { min: 1, max: 10 })),
      country: readStr(env, 'SEARCH_COUNTRY', 'vietnam'),
      cacheTtlMs: /** @type {number} */ (readInt(env, 'SEARCH_CACHE_TTL_MS', 600_000, { min: 0 })),
    },
    image: {
      enabled: readBool(env, 'IMAGE_ENABLED', true),
    },
    sticker: {
      enabled: readBool(env, 'STICKER_ENABLED', true),
      // trả lại đúng sticker khi có người gửi sticker cho bot
      echo: readBool(env, 'STICKER_ECHO', true),
      file: path.join(dataDir, 'stickers.json'),
      // id hợp lệ khai báo sẵn: "id1,id2:tên 2"
      extraIds: parseStickerIds(readStr(env, 'STICKER_IDS')),
    },
    tone: (() => {
      const raw = readStr(env, 'BOT_TONE', 'roast-hard').toLowerCase();
      // nhận alias cho gọn: max/extreme/cuc → roast-extreme, hard → roast-hard, cay → roast
      const alias = {
        max: 'roast-extreme',
        extreme: 'roast-extreme',
        cuc: 'roast-extreme',
        'cực': 'roast-extreme',
        'sieu-nang': 'roast-extreme',
        hard: 'roast-hard',
        nang: 'roast-hard',
        'nặng': 'roast-hard',
        cay: 'roast',
        cakhia: 'roast',
      };
      const tone = alias[raw] ?? raw;
      if (!['friendly', 'roast', 'roast-hard', 'roast-extreme'].includes(tone)) {
        throw new ConfigError(`BOT_TONE phải là friendly, roast, roast-hard hoặc roast-extreme (nhận: "${raw}")`);
      }
      return tone;
    })(),
    typing: cli['no-typing'] ? false : readBool(env, 'TYPING', true),
    typingIntervalMs: /** @type {number} */ (readInt(env, 'TYPING_INTERVAL_MS', 4000, { min: 1000 })),
    progressive: /** @type {ProgressiveMode} */ (progressive),
    progressiveAfterMs: /** @type {number} */ (readInt(env, 'PROGRESSIVE_AFTER_MS', 3000, { min: 500 })),
    // 0 = không giới hạn số tin cho 1 câu trả lời
    maxMessagesPerReply: /** @type {number} */ (readInt(env, 'MAX_MESSAGES_PER_REPLY', 0, { min: 0 })),
    maxQueueDepth: /** @type {number} */ (readInt(env, 'MAX_QUEUE_DEPTH', 50, { min: 1, max: 1000 })),
    // 0 = tắt; mặc định chặn spam đốt credit API
    userRateLimitPerMinute: /** @type {number} */ (readInt(env, 'USER_RATE_LIMIT_PER_MINUTE', 12, { min: 0 })),
    logLevel: cli.verbose ? 'debug' : readStr(env, 'LOG_LEVEL', 'info').toLowerCase(),
    logThinking: readBool(env, 'LOG_THINKING', true),
    logFormat: /** @type {'pretty'|'json'} */ (logFormat),
    logColor: /** @type {'auto'|'always'|'never'} */ (logColor),
    dataDir,
    opsPort: readInt(env, 'OPS_PORT', null, { min: 1, max: 65535 }),
    dryRun: Boolean(cli['dry-run']),
    once: Boolean(cli.once),
  };

  return config;
}

/** Tóm tắt cấu hình an toàn để log lúc khởi động. */
export function describeConfig(config) {
  const primary = MODEL_ALIASES[config.model.defaultAlias];
  const primaryModel = primary ? config[primary.provider]?.[primary.modelKey] : '';
  const fallback = MODEL_ALIASES[config.model.fallbackAlias];
  const fallbackModel = fallback ? config[fallback.provider]?.[fallback.modelKey] : '';
  return {
    version: config.version,
    mode: config.mode,
    model: `${config.model.defaultAlias} (${primaryModel})`,
    fallbackModel: fallback ? `${config.model.fallbackAlias} (${fallbackModel || 'off'})` : 'off',
    reasoning: config.ai.reasoning,
    tone: config.tone,
    maxTokens: config.ai.maxTokens ?? 'unlimited',
    search: config.search.enabled ? `${config.search.depth}/${config.search.maxResults}` : 'off',
    typing: config.typing,
    progressive: config.progressive,
    dataDir: config.dataDir,
    contextDir: config.context.dir,
    contextTtl: config.context.ttlHours > 0 ? `${config.context.ttlHours}h` : 'never',
    context:
      config.context.maxTokens > 0 || config.context.maxMessages > 0
        ? `${config.context.maxTokens > 0 ? `${config.context.maxTokens} tok` : '∞ tok'} / ${config.context.maxMessages > 0 ? `${config.context.maxMessages} msg` : '∞ msg'}`
        : 'unlimited',
    replyChunks: config.maxMessagesPerReply > 0 ? `≤${config.maxMessagesPerReply}` : 'unlimited',
    userRateLimit:
      config.userRateLimitPerMinute > 0 ? `${config.userRateLimitPerMinute}/min/user` : 'off',
    allowedChats: config.allowedChatIds.length || 'all',
    admins: config.adminIds.length || 'everyone',
    token: maskSecret(config.zalo.token),
    nimKey: maskSecret(config.nim.apiKey),
    deepseekKey: maskSecret(config.deepseek.apiKey),
    tavilyKey: maskSecret(config.search.apiKey),
    dryRun: config.dryRun,
  };
}

export const __test__ = { readBool, readInt, readList };
