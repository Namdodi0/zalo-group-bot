import http from 'node:http';
import { createAgent } from './ai/agent.js';
import { DEEPSEEK_REASONING_MAP, NIM_REASONING_MAP, createLlmClient } from './ai/nim.js';
import { createModelRouter } from './ai/router.js';
import { createStickerStore } from './ai/stickers.js';
import { createToolRuntime } from './ai/tools.js';
import { createCommands } from './commands/index.js';
import { collectSecrets, ConfigError, describeConfig, HELP_TEXT, loadConfig } from './config.js';
import { createContextStore } from './context/store.js';
import { describeEnvHints, loadEnvFiles } from './env.js';
import { createHttp } from './http.js';
import { createLogger, printBanner } from './logger.js';
import { createImageValidator } from './media/validate.js';
import { createMetrics } from './metrics.js';
import { createTavilyClient } from './search/tavily.js';
import { createZaloClient } from './zalo/client.js';
import { VERSION } from './version.js';
import { startPolling } from './zalo/polling.js';
import { createWebhookServer } from './zalo/webhook.js';

// Nạp .env ngay trong code, TRƯỚC khi đọc config: panel host / pm2 / systemd hay
// chạy `node index.js` mà bỏ cờ --env-file-if-exists. Biến có sẵn trong môi trường
// vẫn được ưu tiên (xem src/env.js).
const envReport = loadEnvFiles();

async function main() {
  const config = loadConfig();
  if (config.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  const logger = createLogger({
    level: config.logLevel,
    format: config.logFormat,
    color: config.logColor,
    secrets: collectSecrets(config),
    version: config.version,
  });
  const metrics = createMetrics();

  logger.debug('config', describeConfig(config));
  logger.debug('env files', {
    cwd: envReport.cwd,
    files: envReport.files.map((file) => ({
      name: file.name,
      found: file.found,
      applied: file.applied.length,
      ...(file.error ? { error: file.error } : {}),
    })),
  });
  logger.info('starting zalo-group-bot', {
    mode: config.mode,
    ...(config.dryRun ? { dryRun: true } : {}),
    icon: '🚀',
  });

  const httpClient = createHttp({ logger, metrics });

  const store = createContextStore({
    dir: config.context.dir,
    logger,
    ttlHours: config.context.ttlHours,
  });
  await store.init();

  const zalo = createZaloClient({
    token: config.zalo.token,
    baseUrl: config.zalo.baseUrl,
    parseMode: config.zalo.parseMode,
    http: httpClient,
    logger,
    metrics,
    dryRun: config.dryRun,
    typingIntervalMs: config.typingIntervalMs,
  });

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
        cacheTtlMs: config.search.cacheTtlMs,
      })
    : null;

  const validator = createImageValidator({ logger, timeoutMs: 4000 });
  const stickers = createStickerStore({ file: config.sticker.file, extraIds: config.sticker.extraIds, logger });
  await stickers.load();
  const tools = createToolRuntime({ config, tavily, zalo, validator, stickers, logger, metrics });
  const commands = createCommands({ config, store, metrics, zalo, http: httpClient, models, stickers, logger });
  const agent = createAgent({ config, logger, metrics, zalo, llm: models, store, tools, commands, stickers, http: httpClient });

  const primary = models.resolve(null);
  const fallback = models.resolve({ meta: { model: models.fallbackAlias } });

  // Xác thực bot token + lấy display name để strip mention.
  try {
    const me = await zalo.getMe();
    zalo.displayName = String(me.display_name ?? me.account_name ?? '');
    if (config.logFormat === 'pretty') {
      printBanner(
        process.stdout,
        [
          `🤖 ${zalo.displayName || 'Bot Zalo'}  ·  v${config.version}  ·  Zalo group chatbot`,
          `🧠 ${primary.label} · ${primary.provider}/${primary.model}  (fallback: ${fallback.alias})`,
          `⚙️  ${config.mode} · reasoning=${config.ai.reasoning} · max_tokens=${config.ai.maxTokens ?? 'không giới hạn'}`,
          `🔎 search=${config.search.enabled ? `${config.search.depth}/${config.search.maxResults}${config.search.auto ? '' : ' (auto off)'}` : 'off'} · emoji=${config.emoji ? 'on' : 'off'} · typing=${config.typing ? 'on' : 'off'} · progressive=${config.progressive} · sticker=${config.sticker.enabled ? 'on' : 'off'}`,
          `📚 context ${config.context.maxTokens > 0 || config.context.maxMessages > 0 ? `${config.context.maxTokens > 0 ? config.context.maxTokens : '∞'} tokens / ${config.context.maxMessages > 0 ? config.context.maxMessages : '∞'} tin` : 'không giới hạn'} · trả lời ${config.maxMessagesPerReply > 0 ? `≤ ${config.maxMessagesPerReply} tin` : 'không giới hạn tin'}`,
        ],
        { color: config.logColor },
      );
    }
    logger.info('zalo bot ready', {
      id: me.id,
      name: zalo.displayName,
      groups: me.can_join_groups,
      icon: '🤖',
    });
    if (config.zalo.botId && me.id && String(me.id) !== config.zalo.botId) {
      logger.warn('ZALO_BOT_ID không khớp với token', { expected: config.zalo.botId, actual: me.id });
    }
    if (me.can_join_groups !== true) {
      logger.warn('bot này chưa được phép tham gia group (can_join_groups=false)');
    }
    if (!config.allowedChatIds.length) {
      logger.warn('ALLOWED_CHAT_IDS đang trống: bot sẽ trả lời mọi chat. Nên điền chat.id của group.');
    }
  } catch (error) {
    logger.error('không gọi được getMe — kiểm tra ZALO_BOT_TOKEN', { error });
    process.exitCode = 1;
    return;
  }

  if (!config.dryRun) {
    // Warmup TUẦN TỰ, mỗi cặp provider+model đúng 1 lần.
    // Trước đây 2 alias (nim, nim-light) cùng provider nên warmup chạy SONG SONG 2 request
    // tới NIM → request thứ hai bị xếp hàng rồi timeout 20s, log ra "warmup failed" oan.
    const warmTargets = [];
    for (const alias of new Set([models.defaultAlias, models.fallbackAlias])) {
      const target = models.find(alias);
      const client = target ? clients[target.provider] : null;
      if (!client) continue;
      const key = `${target.provider}:${target.model}`;
      if (warmTargets.some((item) => item.key === key)) continue;
      warmTargets.push({ key, alias, target, client });
    }
    // Không await: warmup chạy nền, bot vào polling ngay.
    (async () => {
      for (const item of warmTargets) {
        const result = await item.client.warmup({ model: item.target.model });
        const fields = {
          alias: item.alias,
          provider: item.target.provider,
          model: item.target.model,
          ms: result.ms,
          icon: '⚡',
        };
        if (result.ok) {
          logger.info('llm warmup done', fields);
        } else {
          // Warmup là tối ưu, thất bại không ảnh hưởng gì → để mức debug cho đỡ hoang mang.
          logger.debug('llm warmup bỏ qua (không ảnh hưởng)', { ...fields, error: result.error });
        }
      }
    })();
  }

  const controller = new AbortController();
  /** @type {Array<() => Promise<void>|void>} */
  const cleanups = [];
  /** @type {Promise<void>|null} */
  let shutdownPromise = null;

  /** @param {string} reason */
  function shutdown(reason) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      logger.info('shutting down', { reason, icon: '👋' });
      controller.abort();
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          logger.warn('cleanup failed', { error });
        }
      }
      try {
        zalo.stopAllTyping();
        await store.flush();
      } catch (error) {
        logger.warn('flush on shutdown failed', { error });
      }
      logger.info('session summary', {
        messages: metrics.get('messages.in'),
        replies: metrics.get('messages.replied'),
        errors: metrics.get('messages.error'),
        aiCalls: metrics.get('llm.calls'),
        searches: metrics.get('tool.webSearch'),
        images: metrics.get('tool.sendImage.ok'),
        icon: '📊',
      });
    })();
    return shutdownPromise;
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT').then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').then(() => process.exit(0));
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { error: reason });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error });
  });

  const pruneTimer = setInterval(() => {
    store.prune().catch((error) => logger.warn('prune failed', { error }));
  }, 3_600_000);
  pruneTimer.unref?.();
  cleanups.push(() => clearInterval(pruneTimer));

  /** @type {import('node:http').Server|null} */
  let opsServer = null;
  if (config.opsPort) {
    opsServer = http.createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, uptimeSec: Math.round(process.uptime()) }));
        return;
      }
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            {
              ...metrics.snapshot(),
              agent: { queueDepth: agent.pending(), seen: agent.seenSize() },
              contexts: { loaded: store.loadedChats() },
              config: describeConfig(config),
            },
            null,
            2,
          ),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    opsServer.on('error', (error) => {
      logger.error('ops server lỗi (kiểm tra OPS_PORT)', { error });
    });
    opsServer.listen(config.opsPort, '127.0.0.1');
    cleanups.push(() => new Promise((resolve) => opsServer?.close(() => resolve(undefined))));
    logger.info('ops server listening', { port: config.opsPort, url: `http://127.0.0.1:${config.opsPort}/metrics` });
  }

  if (config.mode === 'webhook') {
    const server = createWebhookServer({
      config,
      logger,
      metrics,
      onEvent: (event) => {
        agent.enqueue(event);
      },
    });
    const { port, url } = await server.start();
    cleanups.push(() => server.stop());
    logger.info('webhook server listening', { port, path: config.webhook.path, icon: '🌐' });

    if (config.webhook.publicUrl) {
      try {
        const result = await zalo.setWebhook(config.webhook.publicUrl, config.webhook.secret);
        logger.info('setWebhook ok', { result, icon: '🔗' });
      } catch (error) {
        logger.error('setWebhook failed', { error });
      }
    } else {
      logger.info('chưa đăng ký webhook — đặt WEBHOOK_PUBLIC_URL hoặc gọi setWebhook thủ công', {
        localUrl: url,
        icon: '🔗',
      });
    }

    await new Promise((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
    await shutdown('webhook loop ended');
    return;
  }

  // Polling (mặc định)
  if (config.once) {
    logger.info('chạy --once: nhận tối đa 1 lượt update rồi thoát');
  }
  await startPolling({
    zalo,
    onEvent: (event) => {
      agent.enqueue(event);
    },
    logger,
    metrics,
    signal: controller.signal,
    once: config.once,
  });

  if (config.once) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await shutdown('once finished');
    process.exit(0);
  }

  await new Promise((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(undefined), { once: true });
  });
  await shutdown('polling loop ended');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  // Có version cả ở nhánh lỗi: log panel chỉ hiện vài dòng cuối, phải biết đang chạy bản nào.
  process.stderr.write(`fatal [v${VERSION}]: ${message}\n`);
  if (error instanceof ConfigError) {
    // Chỉ ra đã tìm .env ở đâu, file nào thiếu → khỏi đoán mò trên panel.
    const hints = describeEnvHints();
    if (hints.length) process.stderr.write(`hint:\n${hints.join('\n')}\n`);
  }
  process.exit(1);
});
