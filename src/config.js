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

// Root directory of the repo, derived from this file (src/..) — NOT dependent on cwd.
// Panel/pm2/systemd may start the bot with a different cwd, which makes a relative DATA_DIR
// point at a brand-new directory and the context "disappear" after every restart.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A DATA_DIR inside a temp directory is guaranteed to be lost on restart/redeploy.
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
  throw new ConfigError(`${key} must be on/off (got: "${raw}")`);
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
    throw new ConfigError(`${key} must be an integer (got: "${raw}")`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new ConfigError(`${key} must be >= ${bounds.min} (got: ${value})`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new ConfigError(`${key} must be <= ${bounds.max} (got: ${value})`);
  }
  return value;
}

/**
 * @param {Record<string, unknown>} env
 * @param {string} key
 * @param {number} fallback
 * @param {{min?:number,max?:number}} [bounds]
 * @returns {number}
 */
function readNumber(env, key, fallback, bounds = {}) {
  const raw = readStr(env, key);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigError(`${key} must be a number (got: "${raw}")`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new ConfigError(`${key} must be >= ${bounds.min} (got: ${value})`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new ConfigError(`${key} must be <= ${bounds.max} (got: ${value})`);
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

/** Shorten a secret so it is safe to print in logs. */
export function maskSecret(value) {
  if (!value) return '(empty)';
  const text = String(value);
  if (text.length <= 10) return '***';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

/** List the secrets that must be redacted in logs. */
export function collectSecrets(config) {
  return [
    config.zalo.token,
    config.nim.apiKey,
    config.deepseek.apiKey,
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

export const HELP_TEXT = `zalo-group-bot — Zalo bot for group chats (NVIDIA NIM + Tavily)

Usage: node index.js [flags]      (.env is loaded automatically from the working directory)

Flags:
  --model <alias>     Default model: deepseek | pro | nim | ultra | nim-light
  --mode <m>          polling | webhook
  --think <mode>      none | low | medium | high | auto
  --max-tokens <n>    Cap on generated tokens (empty = unlimited)
  --progressive <m>   auto | on | off  (send chunked replies on slow answers)
  --no-progressive    Disable chunked replies
  --no-search         Disable web search
  --no-typing         Do not send the "typing" status
  --dry-run           Do not send real messages (log only)
  --once              Handle a single update then exit (for testing)
  --verbose           Debug-level logging
  --json              JSON logs (default is pretty, with colors + icons)
  --help              Print this help

Environment variables: see .env.example`;

/**
 * Webhook secret: prefer the env; if missing, generate it once and store it in data/
 * so a restart does not change the secret (which would make every request fail with 403).
 * @param {Record<string, unknown>} env
 * @param {string} dataDir
 * @param {string} mode
 */
function resolveWebhookSecret(env, dataDir, mode) {
  const fromEnv = readStr(env, 'WEBHOOK_SECRET');
  if (fromEnv) {
    if (fromEnv.length < 8) throw new ConfigError('WEBHOOK_SECRET must be at least 8 characters');
    return fromEnv;
  }
  if (mode !== 'webhook') return '';

  const file = path.join(dataDir, 'webhook-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 8) return existing;
  } catch {
    // no file yet → generate one below
  }

  const generated = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, generated, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // if it cannot be saved, still use a temporary secret for this session
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
    throw new ConfigError(`MODE must be "polling" or "webhook" (got: "${mode}")`);
  }

  const reasoning = String(
    cli.think ?? readStr(env, 'AI_REASONING', readStr(env, 'NIM_REASONING', 'none')),
  ).toLowerCase();
  if (!['none', 'low', 'medium', 'high', 'auto'].includes(reasoning)) {
    throw new ConfigError(`AI_REASONING must be none|low|medium|high|auto (got: "${reasoning}")`);
  }

  let progressive = String(
    cli['no-progressive'] ? 'off' : cli.progressive ?? readStr(env, 'PROGRESSIVE', 'auto'),
  ).toLowerCase();
  if (!['auto', 'on', 'off'].includes(progressive)) {
    throw new ConfigError(`PROGRESSIVE must be auto|on|off (got: "${progressive}")`);
  }

  const logFormat = String(cli.json ? 'json' : readStr(env, 'LOG_FORMAT', 'pretty')).toLowerCase();
  if (!['pretty', 'json'].includes(logFormat)) {
    throw new ConfigError(`LOG_FORMAT must be pretty or json (got: "${logFormat}")`);
  }

  const logColor = readStr(env, 'LOG_COLOR', 'auto').toLowerCase();
  if (!['auto', 'always', 'never'].includes(logColor)) {
    throw new ConfigError(`LOG_COLOR must be auto|always|never (got: "${logColor}")`);
  }

  const maxTokensRaw =
    cli['max-tokens'] !== undefined ? String(cli['max-tokens']) : readStr(env, 'NIM_MAX_TOKENS');
  let maxTokens = null;
  if (maxTokensRaw) {
    const parsed = Number(maxTokensRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new ConfigError(`NIM_MAX_TOKENS must be an integer >= 0 or left empty (got: "${maxTokensRaw}")`);
    }
    // 0 = unlimited (same as leaving it empty)
    maxTokens = parsed === 0 ? null : parsed;
  }

  const token = readStr(env, 'ZALO_BOT_TOKEN');
  if (!token) throw new ConfigError('Missing ZALO_BOT_TOKEN (see .env.example)');

  const apiKey = readStr(env, 'NIM_API_KEY');
  const deepseekKey = readStr(env, 'DEEPSEEK_API_KEY');

  const defaultAlias = String(cli.model ?? readStr(env, 'MODEL_DEFAULT', DEFAULT_ALIAS)).toLowerCase();
  if (!isKnownAlias(defaultAlias)) {
    throw new ConfigError(
      `MODEL_DEFAULT is invalid (got: "${defaultAlias}"). Choose: ${Object.keys(MODEL_ALIASES).join(', ')}`,
    );
  }
  let fallbackAlias = String(readStr(env, 'MODEL_FALLBACK', FALLBACK_ALIAS)).toLowerCase();
  if (!isKnownAlias(fallbackAlias)) {
    throw new ConfigError(
      `MODEL_FALLBACK is invalid (got: "${fallbackAlias}"). Choose: ${Object.keys(MODEL_ALIASES).join(', ')}`,
    );
  }
  if (fallbackAlias === defaultAlias) fallbackAlias = defaultAlias === 'nim-light' ? 'deepseek' : 'nim-light';

  // Only the provider actually used as the primary needs a key. The fallback is optional:
  // when its provider has no key the model catalog simply drops that alias and picks another
  // available model (or no distinct fallback), instead of refusing to start.
  const primaryProvider = MODEL_ALIASES[defaultAlias].provider;
  if (primaryProvider === 'nim' && !apiKey) {
    throw new ConfigError('Missing NIM_API_KEY (used as the primary model)');
  }
  if (primaryProvider === 'deepseek' && !deepseekKey) {
    throw new ConfigError('Missing DEEPSEEK_API_KEY (see .env.example)');
  }

  const searchEnabled = cli['no-search']
    ? false
    : readBool(env, 'SEARCH_ENABLED', true);
  const tavilyKey = readStr(env, 'TAVILY_API_KEY');
  if (searchEnabled && !tavilyKey) {
    throw new ConfigError('SEARCH_ENABLED=on but TAVILY_API_KEY is missing (or use --no-search)');
  }

  let webhookSecret = '';
  // Relative → resolve against the repo root so the panel/pm2 cwd cannot change where context is stored.
  const dataDirRaw = readStr(env, 'DATA_DIR', './data').trim() || './data';
  const dataDir = path.isAbsolute(dataDirRaw)
    ? path.normalize(dataDirRaw)
    : path.resolve(PROJECT_ROOT, dataDirRaw);
  webhookSecret = resolveWebhookSecret(env, dataDir, mode);

  const depthRaw = readStr(env, 'SEARCH_DEPTH', 'fast');
  if (!['fast', 'basic', 'advanced', 'ultra-fast'].includes(depthRaw)) {
    throw new ConfigError(`SEARCH_DEPTH must be fast|basic|advanced|ultra-fast (got: "${depthRaw}")`);
  }

  const config = {
    help: false,
    version: VERSION,
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
      temperature: readNumber(env, 'NIM_TEMPERATURE', 0.6, { min: 0, max: 2 }),
      // 0 = no request timeout (wait for the provider as long as it needs).
      timeoutMs: /** @type {number} */ (readInt(env, 'NIM_TIMEOUT_MS', 0, { min: 0 })),
    },
    deepseek: {
      apiKey: deepseekKey,
      baseUrl: readStr(env, 'DEEPSEEK_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
      model: readStr(env, 'DEEPSEEK_MODEL', 'deepseek-flash'),
      proModel: readStr(env, 'DEEPSEEK_PRO_MODEL', 'deepseek-v4-pro'),
      temperature: readNumber(env, 'DEEPSEEK_TEMPERATURE', 0.6, { min: 0, max: 2 }),
      timeoutMs: /** @type {number} */ (readInt(env, 'DEEPSEEK_TIMEOUT_MS', 0, { min: 0 })),
    },
    model: {
      defaultAlias,
      fallbackAlias,
    },
    ai: {
      reasoning: /** @type {ReasoningMode} */ (reasoning),
      maxTokens,
      timeoutMs: /** @type {number} */ (readInt(env, 'NIM_TIMEOUT_MS', 0, { min: 0 })),
    },
    // 0 = no deadline (the bot waits until the provider answers).
    responseTimeoutMs: /** @type {number} */ (readInt(env, 'RESPONSE_TIMEOUT_MS', 0, { min: 0 })),
    context: {
      dir: path.join(dataDir, 'contexts'),
      // 0 = unlimited
      maxTokens: /** @type {number} */ (readInt(env, 'CONTEXT_MAX_TOKENS', 0, { min: 0 })),
      maxMessages: /** @type {number} */ (readInt(env, 'CONTEXT_MAX_MESSAGES', 0, { min: 0 })),
      maxCharsPerMessage: /** @type {number} */ (readInt(env, 'CONTEXT_MAX_CHARS_PER_MESSAGE', 12000, { min: 0 })),
      ttlHours: /** @type {number} */ (readInt(env, 'CONTEXT_TTL_HOURS', 72, { min: 0 })),
      // ttlHours = 0 → never auto-delete the context
      summary: readBool(env, 'CONTEXT_SUMMARY', true),
      // 0 = unknown context window → only compact when the provider reports overflow
      modelWindow: /** @type {number} */ (readInt(env, 'CONTEXT_MODEL_WINDOW', 0, { min: 0 })),
      compactThreshold: (() => {
        const raw = readStr(env, 'CONTEXT_COMPACT_THRESHOLD');
        if (!raw) return 0.8;
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0 || value > 1) {
          throw new ConfigError(`CONTEXT_COMPACT_THRESHOLD must be within (0, 1] (got: "${raw}")`);
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
      // echo the same sticker back when someone sends a sticker to the bot
      echo: readBool(env, 'STICKER_ECHO', true),
      file: path.join(dataDir, 'stickers.json'),
      // pre-declared valid IDs: "id1,id2:name 2"
      extraIds: parseStickerIds(readStr(env, 'STICKER_IDS')),
    },
    tone: (() => {
      const raw = readStr(env, 'BOT_TONE', 'roast-hard').toLowerCase();
      // accept short aliases: max/extreme/cuc → roast-extreme, hard → roast-hard, cay → roast
      const alias = {
        max: 'roast-extreme',
        extreme: 'roast-extreme',
        cuc: 'roast-extreme',
        'c\u1EF1c': 'roast-extreme',
        'sieu-nang': 'roast-extreme',
        hard: 'roast-hard',
        nang: 'roast-hard',
        'n\u1EB7ng': 'roast-hard',
        cay: 'roast',
        cakhia: 'roast',
      };
      const tone = alias[raw] ?? raw;
      if (!['friendly', 'roast', 'roast-hard', 'roast-extreme'].includes(tone)) {
        throw new ConfigError(`BOT_TONE must be friendly, roast, roast-hard or roast-extreme (got: "${raw}")`);
      }
      return tone;
    })(),
    typing: cli['no-typing'] ? false : readBool(env, 'TYPING', true),
    typingIntervalMs: /** @type {number} */ (readInt(env, 'TYPING_INTERVAL_MS', 4000, { min: 1000 })),
    progressive: /** @type {ProgressiveMode} */ (progressive),
    progressiveAfterMs: /** @type {number} */ (readInt(env, 'PROGRESSIVE_AFTER_MS', 3000, { min: 500 })),
    // 0 = unlimited messages per reply
    maxMessagesPerReply: /** @type {number} */ (readInt(env, 'MAX_MESSAGES_PER_REPLY', 0, { min: 0 })),
    maxQueueDepth: /** @type {number} */ (readInt(env, 'MAX_QUEUE_DEPTH', 50, { min: 1, max: 1000 })),
    // 0 = off; enabled by default to block spam that burns API credits
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

/** Safe config summary for the startup log. */
export function describeConfig(config) {
  const primary = MODEL_ALIASES[config.model.defaultAlias];
  const primaryModel = primary ? config[primary.provider]?.[primary.modelKey] : '';
  const fallback = MODEL_ALIASES[config.model.fallbackAlias];
  const fallbackModel = fallback ? config[fallback.provider]?.[fallback.modelKey] : '';
  const fallbackReady = Boolean(fallback && config[fallback.provider]?.apiKey);
  return {
    version: config.version,
    mode: config.mode,
    model: `${config.model.defaultAlias} (${primaryModel})`,
    fallbackModel: fallback
      ? `${config.model.fallbackAlias} (${fallbackReady ? fallbackModel || 'off' : 'no key — skipped'})`
      : 'off',
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
