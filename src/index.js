import http from 'node:http';
import { createAgent } from './ai/agent.js';
import { DEEPSEEK_REASONING_MAP, NIM_REASONING_MAP, createOpenAiCompatAdapter } from './ai/llm/adapter-openai.js';
import { createLlmService } from './ai/llm/service.js';
import { createModelRouter } from './ai/router.js';
import { createSummarizer } from './ai/summarize.js';
import { createStickerStore } from './ai/stickers.js';
import { createToolRuntime } from './ai/tools.js';
import { createCommands } from './commands/index.js';
import { collectSecrets, ConfigError, describeConfig, HELP_TEXT, isEphemeralDataDir, loadConfig } from './config.js';
import { createCompactionEngine } from './context/compaction/engine.js';
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

// Load .env inside the code, BEFORE reading the config: host panels / pm2 / systemd often
// run `node index.js` and drop the --env-file-if-exists flag. Variables already in the
// environment still take precedence (see src/env.js).
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
  if (config.logThinking !== false && config.ai.reasoning === 'none') {
    logger.info('AI_REASONING=none means the model returns no thinking — set low|medium|high|auto to see the 🧠 line');
  }

  const httpClient = createHttp({ logger, metrics });

  const store = createContextStore({
    dir: config.context.dir,
    logger,
    ttlHours: config.context.ttlHours,
  });
  await store.init();
  const contextFiles = await store.count();
  logger.info('context store', {
    dir: config.context.dir,
    files: contextFiles,
    ttl: config.context.ttlHours > 0 ? `${config.context.ttlHours}h` : 'never',
    icon: '📚',
  });
  if (isEphemeralDataDir(config.dataDir)) {
    logger.warn('DATA_DIR is inside a temp directory — context will be lost on restart/redeploy', {
      dir: config.dataDir,
    });
  }

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

  /** @type {any[]} */
  const adapters = [];
  if (config.deepseek.apiKey) {
    adapters.push(
      createOpenAiCompatAdapter({
        provider: 'deepseek',
        apiKey: config.deepseek.apiKey,
        baseUrl: config.deepseek.baseUrl,
        model: config.deepseek.model,
        http: httpClient,
        logger,
        metrics,
        defaultTemperature: config.deepseek.temperature,
        reasoningMap: DEEPSEEK_REASONING_MAP,
      }),
    );
  }
  if (config.nim.apiKey) {
    adapters.push(
      createOpenAiCompatAdapter({
        provider: 'nim',
        apiKey: config.nim.apiKey,
        baseUrl: config.nim.baseUrl,
        model: config.nim.model,
        http: httpClient,
        logger,
        metrics,
        defaultTemperature: config.nim.temperature,
        reasoningMap: NIM_REASONING_MAP,
      }),
    );
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
        cacheTtlMs: config.search.cacheTtlMs,
      })
    : null;

  const validator = createImageValidator({ logger, timeoutMs: 4000 });
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

  const primary = models.resolve(null);
  const fallback = models.resolve({ meta: { model: models.fallbackAlias } });

  // Verify the bot token + fetch the display name so mentions can be stripped.
  try {
    const me = await zalo.getMe();
    zalo.displayName = String(me.display_name ?? me.account_name ?? '');
    if (config.logFormat === 'pretty') {
      printBanner(
        process.stdout,
        [
          `🤖 ${zalo.displayName || 'Bot Zalo'}  ·  v${config.version}  ·  Zalo group chatbot`,
          `🧠 ${primary.label} · ${primary.provider}/${primary.model}  (fallback: ${fallback.alias})`,
          `⚙️  ${config.mode} · reasoning=${config.ai.reasoning} · max_tokens=${config.ai.maxTokens ?? 'unlimited'}`,
          `🔎 search=${config.search.enabled ? `${config.search.depth}/${config.search.maxResults}${config.search.auto ? '' : ' (auto off)'}` : 'off'} · typing=${config.typing ? 'on' : 'off'} · progressive=${config.progressive} · sticker=${config.sticker.enabled ? 'on' : 'off'}`,
          `📚 context ${config.context.maxTokens > 0 || config.context.maxMessages > 0 ? `${config.context.maxTokens > 0 ? config.context.maxTokens : '∞'} tokens / ${config.context.maxMessages > 0 ? config.context.maxMessages : '∞'} msgs` : 'unlimited'} · replies ${config.maxMessagesPerReply > 0 ? `≤ ${config.maxMessagesPerReply} msgs` : 'unlimited msgs'}`,
          `💾 data ${config.dataDir} · ${contextFiles} file context · TTL ${config.context.ttlHours > 0 ? `${config.context.ttlHours}h` : 'never'}`,        ],
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
      logger.warn('ZALO_BOT_ID does not match the token', { expected: config.zalo.botId, actual: me.id });
    }
    if (me.can_join_groups !== true) {
      logger.warn('this bot is not allowed to join groups (can_join_groups=false)');
    }
    if (!config.allowedChatIds.length) {
      logger.warn('ALLOWED_CHAT_IDS is empty: the bot will reply to every chat. You should set the group chat.id.');
    }
  } catch (error) {
    logger.error('could not call getMe — check ZALO_BOT_TOKEN', { error });
    process.exitCode = 1;
    return;
  }

  if (!config.dryRun) {
    // Warm up SEQUENTIALLY, exactly once per provider+model pair.
    // Previously the two aliases (nim, nim-light) shared a provider, so warmup fired 2 requests
    // to NIM IN PARALLEL → the second one queued up and timed out after 20s, logging a bogus "warmup failed".
    const warmTargets = [];
    for (const alias of new Set([models.defaultAlias, models.fallbackAlias])) {
      const target = models.find(alias);
      if (!target) continue;
      const key = `${target.provider}:${target.model}`;
      if (warmTargets.some((item) => item.key === key)) continue;
      warmTargets.push({ key, alias, target });
    }
    // No await: warmup runs in the background, the bot enters polling right away.
    (async () => {
      for (const item of warmTargets) {
        const result = await models.warmup(item.alias);
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
          // Warmup is only an optimization, a failure changes nothing → keep it at debug level to avoid confusion.
          logger.debug('llm warmup skipped (no impact)', { ...fields, error: result.error });
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
      // Close the message sources (webhook/ops) first so the queue stops growing while waiting.
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          logger.warn('cleanup failed', { error });
        }
      }
      // Wait for in-flight messages to finish sending before closing: otherwise a redeploy could
      // cut a reply short and save a context missing the assistant turn.
      try {
        const left = await agent.drain(10_000);
        if (left > 0) logger.warn('shutdown: messages still unfinished', { pending: left, icon: '⏳' });
      } catch (error) {
        logger.warn('drain on shutdown failed', { error });
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
      logger.error('ops server error (check OPS_PORT)', { error });
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
      logger.info('webhook not registered yet — set WEBHOOK_PUBLIC_URL or call setWebhook manually', {
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

  // Polling (default)
  if (config.once) {
    logger.info('running --once: handle at most 1 update then exit');
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
  // Include the version on the error path too: panel logs only show the last few lines, so you must know which build is running.
  process.stderr.write(`fatal [v${VERSION}]: ${message}\n`);
  if (error instanceof ConfigError) {
    // Show where .env was looked for and which files are missing → no more guessing on the panel.
    const hints = describeEnvHints();
    if (hints.length) process.stderr.write(`hint:\n${hints.join('\n')}\n`);
  }
  process.exit(1);
});
