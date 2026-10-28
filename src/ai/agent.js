import { assembleRequest } from '../context/assembler.js';
import {
  searchEntry,
  syncContexts,
  toolCallEntry,
  toolResultEntry,
  turnEntry,
} from '../context/record.js';
import { createTokenMeter } from '../context/token-meter.js';
import { CircuitOpenError, HttpError } from '../http.js';
import {
  chunkText,
  normalizeWhitespace,
  prepareOutgoing,
  stripMention,
  truncate,
} from '../text/format.js';
import { LLM_ERROR, isRetryableLlmError } from './llm/errors.js';
import { createRetryExecutor } from './llm/retry.js';
import { buildSearchContext, createZaloPrompt } from './prompt/index.js';

const MAX_CONCURRENT_CHATS = 4;
const MAX_TOOL_ROUNDS = 3;
const CHUNK_LIMIT = 1900;
const FALLBACK_RESERVE_RATIO = 0.25;
const FALLBACK_RESERVE_MAX_MS = 8000;
const FALLBACK_MIN_MS = 2500;
const MIN_ATTEMPT_MS = 1500;

/**
 * Chia ngân sách một attempt. Non-streaming giữ lại một phần deadline cho fallback;
 * streaming không giữ (câu trả lời dài cần chạy tới deadline), TTFT guard lo phần treo.
 * @param {{remainingMs: number, attempt: number, maxAttempts: number, streaming: boolean, aiTimeoutMs: number}} input
 */
function planAttemptBudget(input) {
  const remaining = Math.max(0, input.remainingMs);
  const reserveMs = input.streaming
    ? 0
    : Math.min(FALLBACK_RESERVE_MAX_MS, Math.floor(remaining * FALLBACK_RESERVE_RATIO));
  const primaryMs = Math.max(0, remaining - reserveMs);
  const attemptsLeft = Math.max(1, input.maxAttempts - input.attempt + 1);
  const ttftMs = Math.max(4000, Math.min(input.aiTimeoutMs, Math.floor(remaining / 2), 9000));

  if (input.streaming) {
    return { reserveMs, primaryMs, timeoutMs: remaining, ttftMs };
  }

  const share = Math.max(MIN_ATTEMPT_MS, Math.floor(primaryMs / attemptsLeft));
  const timeoutMs = Math.max(1000, Math.min(input.aiTimeoutMs, share, primaryMs));
  return { reserveMs, primaryMs, timeoutMs, ttftMs };
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rút gọn text cho log console: bỏ xuống dòng, cắt bớt cho dễ đọc.
 * @param {unknown} text
 * @param {number} [limit]
 */
function preview(text, limit = 900) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * @param {string} buffer
 * @returns {number} vị trí cắt (đã bao gồm dấu câu/newline ở cuối đoạn)
 */
function findBreak(buffer) {
  const positions = [
    buffer.lastIndexOf('\n\n') + 2,
    buffer.lastIndexOf('. ') + 1,
    buffer.lastIndexOf('! ') + 1,
    buffer.lastIndexOf('? ') + 1,
    buffer.lastIndexOf('\n') + 1,
    buffer.lastIndexOf('… ') + 1,
  ]
    .filter((position) => position > 1)
    .sort((a, b) => b - a);

  for (const position of positions) {
    const head = buffer.slice(0, position);
    // Không cắt ngay sau gạch đầu dòng / số thứ tự trơ trọi ("2.", "- ") — xấu khi chia tin.
    if (/(?:^|\n)\s*(?:\d+[.)]|[-*+])\s*$/.test(head)) continue;
    return position;
  }
  return 0;
}

/**
 * @param {{config: any, logger: import('../logger.js').Logger, metrics: any, zalo: ReturnType<typeof import('../zalo/client.js').createZaloClient>, llm: ReturnType<typeof import('./router.js').createModelRouter>, store: ReturnType<typeof import('../context/store.js').createContextStore>, tools: ReturnType<typeof import('./tools.js').createToolRuntime>, commands: ReturnType<typeof import('../commands/index.js').createCommands>, stickers?: ReturnType<typeof import('./stickers.js').createStickerStore>, http?: ReturnType<typeof import('../http.js').createHttp>, compaction: ReturnType<typeof import('../context/compaction/engine.js').createCompactionEngine>}} deps
 */
export function createAgent(deps) {
  const { config, logger, metrics, zalo, llm, store, tools, commands, stickers, compaction } = deps;
  const meter = createTokenMeter();
  const retryExecutor = createRetryExecutor({ shouldRetry: isRetryableLlmError, sleep });

  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {Map<string, number[]>} */
  const userHits = new Map();
  /** @type {Map<string, Promise<void>>} */
  const chatQueues = new Map();
  /** @type {Array<{resolve: () => void, timer: NodeJS.Timeout}>} */
  const drainWaiters = [];

  let active = 0;
  let queueDepth = 0;
  /** @type {Array<() => void>} */
  const waiters = [];

  async function acquire() {
    if (active < MAX_CONCURRENT_CHATS) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiters.push(/** @type {any} */ (resolve)));
    active += 1;
  }

  function release() {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) next();
  }

  /** @param {string} messageId */
  function alreadySeen(messageId) {
    if (!messageId) return false;
    if (seen.has(messageId)) return true;
    seen.set(messageId, Date.now());
    if (seen.size > 2000) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return false;
  }

  const RATE_WINDOW_MS = 60_000;

  /**
   * Giới hạn số tin một người gửi trong 1 phút — chặn spam đốt credit API.
   * Bỏ qua im lặng (không trả lời) để không tiếp tay cho spam.
   * @param {string} senderId
   */
  function rateLimited(senderId) {
    const limit = config.userRateLimitPerMinute ?? 0;
    if (!limit || !senderId) return false;
    const now = Date.now();
    const hits = (userHits.get(senderId) ?? []).filter((ts) => now - ts < RATE_WINDOW_MS);
    if (hits.length >= limit) {
      userHits.set(senderId, hits);
      return true;
    }
    hits.push(now);
    userHits.set(senderId, hits);
    if (userHits.size > 500) {
      const oldest = userHits.keys().next().value;
      if (oldest !== undefined) userHits.delete(oldest);
    }
    return false;
  }

  /**
   * @param {string} chatId
   * @param {() => Promise<void>|void} [onFirstSend] gọi 1 lần ngay trước tin đầu tiên (tắt typing)
   * @returns {{enqueue: (text: string) => Promise<void>, wait: () => Promise<void>, sent: () => number}}
   */
  function makeSender(chatId, onFirstSend = async () => {}) {
    let chain = Promise.resolve();
    let sent = 0;
    let firstSendHandled = false;
    const limit = config.maxMessagesPerReply > 0 ? config.maxMessagesPerReply : Number.POSITIVE_INFINITY;

    /** @param {string} text */
    function enqueue(text) {
      chain = chain
        .then(async () => {
          if (sent >= limit) return;
          if (!firstSendHandled) {
            firstSendHandled = true;
            // tắt "đang soạn tin" TRƯỚC khi gửi tin đầu tiên để Zalo không còn hiện action
            try {
              await onFirstSend();
            } catch {
              // ignore
            }
          }
          const payload = prepareOutgoing(text, {
            parseMode: config.zalo.parseMode,
          });
          if (!payload) return;
          await zalo.sendMessage(chatId, payload);
          sent += 1;
          logger.info(`🤖 bot: ${preview(payload)}`, {
            chatId,
            part: sent,
            ...(config.maxMessagesPerReply > 0 ? { limit: config.maxMessagesPerReply } : {}),
          });
          if (sent < limit) await sleep(300);
        })
        .catch((error) => {
          logger.warn('send message failed', { error: String(error?.message ?? error), chatId, icon: '📤' });
          metrics.inc('messages.sendError');
        });
      return chain;
    }

    return { enqueue, wait: () => chain, sent: () => sent };
  }

  /**
   * @param {ReturnType<typeof makeSender>} sender
   * @param {string} text
   */
  async function sendText(sender, text) {
    const limit =
      config.maxMessagesPerReply > 0
        ? config.maxMessagesPerReply - sender.sent()
        : Number.POSITIVE_INFINITY;
    const remaining = Math.max(0, limit);
    if (remaining <= 0) return 0;
    const { chunks, truncated } = chunkText(text, { limit: CHUNK_LIMIT, maxChunks: remaining });
    if (!chunks.length) return 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const isLast = index === chunks.length - 1;
      const suffix = truncated && isLast ? '\n\n…' : '';
      await sender.enqueue(`${chunks[index]}${suffix}`);
    }
    return chunks.length;
  }

  /**
   * @param {any} record
   * @param {string} text
   */
  function effectiveReasoning(record, text) {
    const override = record?.meta?.thinking;
    if (override === 'off') return 'none';
    if (override && ['low', 'medium', 'high'].includes(override)) return override;
    const base = config.ai.reasoning;
    if (base !== 'auto') return base;
    const wantsDepth = text.length > 200 || /phân tích|giải thích|so sánh|tại sao|vì sao|chi tiết|lên kế hoạch/i.test(text);
    return wantsDepth ? 'low' : 'none';
  }

  /**
   * @param {import('../zalo/events.js').BotEvent} event
   * @param {any} record
   * @param {{forceSearch?: string}} [options]
   * @param {() => Promise<void>|void} [stopTyping]
   */
  async function conversation(event, record, options = {}, stopTyping = async () => {}) {
    const startedAt = Date.now();
    const deadline = startedAt + config.responseTimeoutMs;
    const sender = makeSender(event.chatId, stopTyping);

    const rawText = normalizeWhitespace(event.text ?? '');
    // Model là text-only: ảnh chỉ được ghi chú, không gửi nội dung ảnh lên API.
    const imageNote = 'người dùng gửi kèm ảnh — bot không xem được nội dung';
    const effectiveText =
      rawText || (event.imageUrl ? 'Người dùng đã gửi một ảnh — bot không xem được nội dung.' : '');
    if (!effectiveText) return;

    const textWithImage =
      rawText && event.imageUrl ? `${rawText}\n[${imageNote}]` : effectiveText;
    const storedText =
      event.chatType === 'GROUP' && textWithImage
        ? `${event.senderName}: ${textWithImage}`
        : textWithImage;

    const userTurn = turnEntry({
      text: storedText,
      name: event.senderName,
      ts: Date.now(),
      messageId: event.messageId,
    });

    const tone = record?.meta?.tone ?? config.tone;
    const toolDefs = tools.definitions();
    const promptRegistry = createZaloPrompt({
      botName: zalo.displayName || 'trợ lý AI',
      chatType: event.chatType,
      // Tool guidance chỉ hiện khi schema tương ứng thật sự được gửi lên model.
      tools: toolDefs,
      imageEnabled: config.image.enabled,
      tone,
    });
    const promptAssembly = promptRegistry.assemble({ text: effectiveText, now: new Date() });
    const systemPrompt = promptRegistry.render(promptAssembly);

    const reasoning = effectiveReasoning(record, effectiveText);
    const target = llm.resolve(record);
    // `/split` đặt riêng cho chat này, ưu tiên hơn PROGRESSIVE trong cấu hình.
    const splitMode = ['auto', 'on', 'off'].includes(record?.meta?.split)
      ? record.meta.split
      : config.progressive;
    const streaming = splitMode !== 'off';
    // `on` = gửi tách đoạn sớm (khi có câu hoàn chỉnh); `auto` = chỉ khi chờ lâu.
    const flushAfterMs = splitMode === 'on' ? 0 : config.progressiveAfterMs;
    const minHeadChars = splitMode === 'on' ? 80 : 160;
    // Giới hạn đúng 1 tin thì không tách sớm: gửi phần đầu sẽ chiếm hết slot và
    // phần còn lại bị bỏ mà không có dấu hiệu gì.
    const flushAllowed = config.maxMessagesPerReply !== 1;

    // Lưu lượt của user NGAY (trước khi gọi model) để không mất câu hỏi nếu crash/timeout.
    record.messages.push(userTurn);
    record.turns = (record.turns ?? 0) + 1;

    // /search: kết quả là context bền vững, chèn ngay trước lượt user hiện tại.
    if (options.forceSearch) {
      const search = await tools.run(
        'web_search',
        { query: options.forceSearch },
        { chatId: event.chatId, deadline },
      );
      record.messages.splice(
        record.messages.length - 1,
        0,
        searchEntry(buildSearchContext(options.forceSearch, search.text)),
      );
    }

    // Context runtime (thời gian...) do prompt registry cung cấp, materialize
    // thành message user bền vững — refresh mỗi lượt, không mutate lượt user.
    syncContexts(record, promptAssembly.contexts);
    store.touch(event.chatId);

    const buildAll = () =>
      assembleRequest({
        systemPrompt,
        tools: toolDefs,
        record,
        maxTokens: config.context.maxTokens,
        maxMessages: config.context.maxMessages,
        maxCharsPerMessage: config.context.maxCharsPerMessage,
        contextWindow: target.contextWindow ?? config.context.modelWindow ?? 0,
        meter,
      });

    let built = buildAll();

    try {
      const measure = () => {
        const current = buildAll();
        return { pressure: current.pressure, tokens: current.estimatedTokens };
      };
      const result = await compaction.compactIfNeeded({
        record,
        trigger: built.needsSummary ? 'dropped' : 'pressure',
        deadline,
        measure,
      });
      if (result?.changed) {
        built = buildAll();
        metrics.inc('context.summarized');
      }
    } catch (error) {
      logger.warn('compaction failed, fallback to trimming', {
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
    }

    const messages = built.messages;

    // Bằng chứng context có được gửi lên API: bật LOG_LEVEL=debug sẽ thấy số message
    // (đã gồm lịch sử) và số ký tự của cả payload ở mỗi lượt.
    logger.debug('llm payload', {
      chatId: event.chatId,
      messages: messages.length,
      kept: built.keptMessages,
      dropped: built.dropped,
      estTokens: built.estimatedTokens,
      pressure: built.pressure,
      contextWindow: built.contextWindow,
      chars: messages.reduce(
        (sum, message) =>
          sum + (typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length),
        0,
      ),
    });

    let streamBuffer = '';
    let emitted = 0;
    let flushed = false;
    // Sau một vòng có tool call, nội dung vòng sau là câu trả lời mới hoàn chỉnh —
    // không tách sớm nữa để tránh gửi thiếu/trùng đoạn.
    let flushLocked = false;

    const onDelta = (delta) => {
      if (!streaming || flushed || flushLocked || !flushAllowed) return;
      streamBuffer += delta;
      const elapsed = Date.now() - startedAt;
      if (elapsed < flushAfterMs) return;
      if (streamBuffer.length < minHeadChars) return;
      const cut = findBreak(streamBuffer);
      if (cut < minHeadChars) return;
      const rawHead = streamBuffer.slice(0, cut);
      const head = rawHead.trimEnd();
      streamBuffer = streamBuffer.slice(cut);
      flushed = true;
      emitted = rawHead.length;
      sendText(sender, head).catch((error) => {
        logger.warn('progressive send failed', { error: String(error?.message ?? error), icon: '✂️' });
      });
    };

    let finalText = '';
    let aborted = false;
    // Gom phần "thinking" (reasoning_content) của model để in ra console.
    let thinkingText = '';
    let reasoningTokens = 0;
    // Thống kê LLM của lượt này để log: tổng thời gian gọi, thời gian sinh thật (đã trừ TTFT),
    // số token sinh ra → tok/s. Cộng dồn qua các vòng tool call.
    let llmMs = 0;
    let completionMs = 0;
    let completionTokens = 0;
    let overflowRecovered = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const remaining = deadline - Date.now();
      if (remaining < 1500) {
        aborted = true;
        break;
      }

      /** @type {any} */
      let response = null;
      /** @type {unknown} */
      let lastError = null;

      let attemptIndex = 0;
      const callOnce = async () => {
        attemptIndex += 1;
        const left = deadline - Date.now();
        const budget = planAttemptBudget({
          remainingMs: left,
          attempt: attemptIndex,
          maxAttempts: retryExecutor.maxAttempts,
          streaming,
          aiTimeoutMs: config.ai.timeoutMs,
        });
        // Đo cả lần gọi thất bại: llmMs là tổng thời gian thực sự tiêu vào LLM.
        const callStarted = Date.now();
        try {
          return await llm.chat({
            record,
            messages,
            tools: toolDefs.length ? toolDefs : undefined,
            reasoning,
            temperature: config.ai.temperature,
            maxTokens: config.ai.maxTokens,
            stream: streaming,
            onDelta,
            ttftMs: budget.ttftMs,
            timeoutMs: budget.timeoutMs,
            signal: AbortSignal.timeout(Math.max(1, budget.timeoutMs)),
          });
        } finally {
          llmMs += Date.now() - callStarted;
        }
      };

      try {
        response = await retryExecutor.execute(callOnce, {
          deadline,
          onRetry: (error, nextAttempt) => {
            metrics.inc('llm.retries');
            logger.warn('llm call failed, retrying', {
              attempt: nextAttempt,
              provider: target.provider,
              model: target.model,
              status: /** @type {any} */ (error)?.status,
              error: String(/** @type {any} */ (error)?.message ?? error),
              icon: '🔁',
            });
          },
        });
      } catch (error) {
        lastError = error;

        // Provider xác nhận tràn context: nén rồi thử lại đúng lượt này.
        if (/** @type {any} */ (error)?.code === LLM_ERROR.CONTEXT_WINDOW_EXCEEDED && !overflowRecovered) {
          overflowRecovered = true;
          try {
            const result = await compaction.compactIfNeeded({
              record,
              trigger: 'overflow',
              deadline,
              measure: () => {
                const current = buildAll();
                return { pressure: current.pressure, tokens: current.estimatedTokens };
              },
            });
            if (result?.changed) {
              built = buildAll();
              messages.splice(0, messages.length, ...built.messages);
              metrics.inc('llm.contextOverflow');
              logger.warn('context overflow: đã nén và thử lại', {
                chatId: event.chatId,
                tokensBefore: result.tokensBefore,
                tokensAfter: result.tokensAfter,
                icon: '📉',
              });
              response = await callOnce();
            }
          } catch (recoveryError) {
            logger.warn('overflow recovery failed', {
              error: String(/** @type {any} */ (recoveryError)?.message ?? recoveryError),
            });
          }
        }
      }

      // Fallback cuối: bỏ tool để vẫn có câu trả lời thay vì báo lỗi.
      // `flushed` = đã gửi phần đầu cho user; gọi fallback lúc này sẽ gửi trùng nội dung.
      if (!response && !flushed) {
        let left = deadline - Date.now();
        if (left > 6000) {
          await sleep(800);
          left = deadline - Date.now();
        }
        if (left > FALLBACK_MIN_MS) {
          const fallbackStarted = Date.now();
          try {
            response = await llm.chatWith(llm.fallbackAlias, {
              messages,
              reasoning: 'none',
              temperature: config.ai.temperature,
              maxTokens: config.ai.maxTokens,
              stream: false,
              timeoutMs: Math.max(1500, Math.min(config.ai.timeoutMs, left - 300)),
              signal: AbortSignal.timeout(left),
            });
            llmMs += Date.now() - fallbackStarted;
            metrics.inc('llm.fallback');
            logger.warn('llm fallback (không tool) thành công', {
              chatId: event.chatId,
              fallback: llm.fallbackAlias,
              icon: '🛟',
            });
          } catch (error) {
            llmMs += Date.now() - fallbackStarted;
            lastError = error;
          }
        } else {
          logger.debug('fallback bỏ qua: không đủ thời gian', {
            chatId: event.chatId,
            leftMs: left,
            icon: '⏭️',
          });
        }
      }

      if (!response) {
        // Đã gửi được một phần (progressive) thì coi như xong phần đó.
        if (flushed) {
          aborted = true;
          break;
        }
        throw lastError ?? new Error('Model không phản hồi');
      }

      completionMs += Number(response.completionMs ?? response.latencyMs ?? 0) || 0;
      completionTokens += Number(response.completionTokens ?? response.usage?.completion_tokens ?? 0) || 0;
      // Vòng đầu khớp với `built.estimatedTokens`; các vòng sau có thêm message tool
      // nên không dùng để hiệu chỉnh (sẽ làm lệch tỉ lệ).
      if (round === 0) {
        const promptTokens = Number(response.usage?.prompt_tokens ?? 0);
        if (promptTokens > 0) meter.observe(built.estimatedTokens, promptTokens);
      }
      if (typeof response.reasoning === 'string' && response.reasoning.trim()) {
        thinkingText += `${thinkingText ? '\n\n' : ''}${response.reasoning.trim()}`;
      }
      reasoningTokens += Number(response.usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0;

      if (response.toolCalls?.length) {
        metrics.inc('llm.toolRounds');
        messages.push({
          role: 'assistant',
          content: response.content || null,
          tool_calls: response.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.rawArguments || JSON.stringify(call.arguments) },
          })),
        });
        record.messages.push(
          toolCallEntry({ content: response.content ?? '', toolCalls: response.toolCalls, ts: Date.now() }),
        );

        for (const call of response.toolCalls) {
          const started = Date.now();
          const result = await tools.run(call.name, call.arguments, { chatId: event.chatId, deadline });
          metrics.observe(`tool.${call.name}`, Date.now() - started);
          const text = truncate(result.text, 4000);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: text,
          });
          record.messages.push(toolResultEntry({ toolCallId: call.id, text, ts: Date.now() }));
        }
        store.touch(event.chatId);
        // Đã lỡ gửi phần đầu của vòng này: gửi trọn nội dung vòng cuối thay vì
        // cắt theo `emitted` của vòng trước (có thể dài hơn câu trả lời cuối).
        streamBuffer = '';
        emitted = 0;
        flushLocked = true;
        continue;
      }

      finalText = response.content ?? '';
      aborted = Boolean(response.aborted);
      break;
    }

    await sender.wait();

    const remainder = finalText.slice(emitted);
    if (remainder.trim()) {
      await sendText(sender, remainder);
    } else if (!flushed && !finalText.trim()) {
      await sendText(sender, 'Mình chưa có câu trả lời cho câu này, bạn thử hỏi lại rõ hơn nhé.');
    }

    record.messages.push(
      turnEntry({
        role: 'assistant',
        text: truncate(normalizeWhitespace(finalText), 4000),
        ts: Date.now(),
      }),
    );
    store.touch(event.chatId);

    const duration = Date.now() - startedAt;
    const tps =
      completionTokens > 0 && completionMs > 0
        ? Math.round((completionTokens / (completionMs / 1000)) * 10) / 10
        : 0;
    metrics.observe('agent.reply', duration);
    metrics.inc('messages.replied');
    if (thinkingText && config.logThinking !== false) {
      logger.info(`🧠 thinking: ${preview(thinkingText, 2000)}`, {
        chatId: event.chatId,
        model: target.model,
        ...(reasoningTokens > 0 ? { tokens: reasoningTokens } : {}),
      });
    }
    logger.info(`✅ replied · ${target.model} · ${tps || 0} tok/s`, {
      chatId: event.chatId,
      model: target.model,
      alias: target.alias,
      provider: target.provider,
      tps,
      tokens: completionTokens,
      ms: duration,
      llmMs,
      chars: finalText.length,
      ...(aborted ? { aborted: true } : {}),
      messages: sender.sent(),
      kept: built.keptMessages,
      reasoning, // chế độ suy luận (none/low/...), không phải nội dung thinking
      ...(reasoningTokens > 0 ? { thinkingTokens: reasoningTokens } : {}),
    });

    if (aborted) {
      logger.warn('reply aborted by deadline', { chatId: event.chatId, partial: finalText.length, icon: '⏱️' });
    }
  }

  /**
   * @param {import('../zalo/events.js').BotEvent} event
   */
  async function handle(event) {
    if (!event) return;
    if (event.isBot) return;
    if (event.kind === 'unsupported' || event.kind === 'unknown') return;
    if (config.allowedChatIds.length && !config.allowedChatIds.includes(event.chatId)) {
      logger.debug('chat not allowed, skipping', { chatId: event.chatId, icon: '🚫' });
      return;
    }
    if (alreadySeen(event.messageId)) {
      metrics.inc('messages.duplicate');
      logger.debug('duplicate message skipped', { messageId: event.messageId, icon: '♻️' });
      return;
    }

    metrics.inc('messages.in');
    const incomingPreview =
      event.text && String(event.text).trim() ? preview(event.text, 900) : `[${event.kind}]`;
    logger.info(`💬 ${event.senderName || 'Người dùng'}: ${incomingPreview}`, {
      chatId: event.chatId,
      kind: event.kind,
      len: (event.text ?? '').length,
    });
    const stopTyping = config.typing ? zalo.startTyping(event.chatId) : async () => {};

    try {
      const record = await store.get(event.chatId, { chatType: event.chatType });

      // Dedupe bền: `seen` trong RAM mất khi restart, record thì không.
      // (Hai process cùng chạy chia sẻ file vẫn có thể đua — chạy 1 instance.)
      if (event.messageId) {
        const history = Array.isArray(record.seen) ? record.seen : [];
        if (history.includes(event.messageId)) {
          metrics.inc('messages.duplicate');
          logger.debug('duplicate message skipped (context)', { messageId: event.messageId, icon: '♻️' });
          return;
        }
        record.seen = [...history, event.messageId].slice(-200);
        store.touch(event.chatId);
      }

      if (rateLimited(event.senderId)) {
        metrics.inc('messages.rateLimited');
        logger.warn('sender rate limited, ignoring', {
          chatId: event.chatId,
          senderId: event.senderId,
          perMinute: config.userRateLimitPerMinute,
          icon: '🚦',
        });
        return;
      }

      if (event.kind === 'voice') {
        const sender = makeSender(event.chatId, stopTyping);
        await sendText(sender, 'Mình chưa nghe được tin nhắn thoại, bạn nhắn chữ giúp mình nhé.');
        return;
      }
      if (event.kind === 'sticker') {
        if (config.sticker.enabled && stickers) {
          const isId = /^[a-f0-9]{20}$/i.test(event.sticker ?? '');
          const stickerId = config.sticker.echo && isId ? event.sticker : stickers.random()?.id;
          await stopTyping();
          if (stickerId) {
            try {
              await zalo.sendSticker(event.chatId, stickerId);
              metrics.inc('sticker.reply');
            } catch (error) {
              logger.warn('sticker reply failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
            }
          }
          return;
        }
        const sender = makeSender(event.chatId, stopTyping);
        await sendText(sender, 'Mình chưa xem được sticker, bạn nhắn chữ giúp mình nhé.');
        return;
      }

      const cleanedText = stripMention(event.text ?? '', [zalo.displayName]);
      const command = commands.parseCommand(cleanedText);
      const normalizedEvent = cleanedText === (event.text ?? '') ? event : { ...event, text: cleanedText };
      if (command) {
        const ctx = {
          chatId: event.chatId,
          chatType: event.chatType,
          senderId: event.senderId,
          senderName: event.senderName,
          record,
        };
        const result = await commands.run(command, ctx);
        metrics.inc(`commands.${command.name}`);

        if (result.kind === 'search') {
          await conversation(normalizedEvent, record, { forceSearch: result.query }, stopTyping);
          return;
        }
        if (result.kind === 'image') {
          // ảnh không đi qua makeSender → tự tắt typing trước khi gửi
          await stopTyping();
          const imageResult = await tools.run(
            'send_image',
            { query: result.query },
            { chatId: event.chatId, deadline: Date.now() + config.responseTimeoutMs },
          );
          if (!imageResult.ok) {
            const sender = makeSender(event.chatId, stopTyping);
            await sendText(sender, imageResult.text);
          }
          return;
        }
        if (result.kind === 'sticker') {
          await stopTyping();
          try {
            await zalo.sendSticker(event.chatId, result.stickerId);
            metrics.inc('sticker.command');
          } catch (error) {
            logger.warn('sticker command failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
            const sender = makeSender(event.chatId, stopTyping);
            await sendText(sender, 'Gửi sticker không được, bạn thử lại nhé.');
          }
          return;
        }
        if (result.kind === 'text' && result.text) {
          const sender = makeSender(event.chatId, stopTyping);
          await sendText(sender, result.text);
          return;
        }
        return;
      }

      await conversation(normalizedEvent, record, {}, stopTyping);
    } catch (error) {
      metrics.inc('messages.error');
      const partial = /** @type {any} */ (error);
      logger.error('handle message failed', {
        chatId: event.chatId,
        messageId: event.messageId,
        error,
        status: partial?.status,
        body: typeof partial?.body === 'string' ? partial.body.slice(0, 300) : undefined,
      });

      let text = 'Xin lỗi, mình gặp lỗi khi xử lý tin này. Bạn thử lại giúp mình nhé.';
      if (error instanceof CircuitOpenError) {
        text = 'Mình đang quá tải một chút, bạn thử lại sau ít giây nhé.';
      } else if (error instanceof HttpError && error.status === 401) {
        text = 'Bot đang gặp lỗi xác thực với nhà cung cấp AI. Admin kiểm tra lại key giúp mình nhé.';
      }

      try {
        const sender = makeSender(event.chatId, stopTyping);
        await sendText(sender, text);
      } catch (sendError) {
        logger.error('failed to send error message', { error: sendError });
      }
    } finally {
      try {
        await stopTyping();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Xếp hàng theo chat (giữ thứ tự) + giới hạn đồng thời toàn cục.
   * @param {import('../zalo/events.js').BotEvent} event
   */
  function enqueue(event) {
    const chatId = event?.chatId ?? 'unknown';

    if (queueDepth >= config.maxQueueDepth) {
      metrics.inc('queue.dropped');
      logger.warn('queue đầy, bỏ qua tin', {
        chatId,
        queueDepth,
        max: config.maxQueueDepth,
        icon: '🧯',
      });
      // báo nhẹ cho người dùng, không xếp vào queue
      const chatAllowed = !config.allowedChatIds.length || config.allowedChatIds.includes(chatId);
      if (chatAllowed) {
        zalo
          .sendMessage(chatId, 'Mình đang xử lý nhiều tin quá, bạn thử lại sau ít giây nhé.')
          .catch((error) => logger.debug('busy notice failed', { error: String(error?.message ?? error) }));
      }
      return Promise.resolve();
    }

    queueDepth += 1;
    let acquired = false;
    const previous = chatQueues.get(chatId) ?? Promise.resolve();
    const task = previous
      .then(() => acquire())
      .then(() => {
        acquired = true;
        return handle(event);
      })
      .catch((error) => logger.error('queued handler crashed', { error }))
      .finally(() => {
        queueDepth = Math.max(0, queueDepth - 1);
        if (acquired) release();
        notifyDrainWaiters();
      });

    chatQueues.set(chatId, task);
    task.finally(() => {
      if (chatQueues.get(chatId) === task) chatQueues.delete(chatId);
    });
    return task;
  }

  function pending() {
    return queueDepth;
  }

  function notifyDrainWaiters() {
    if (queueDepth > 0) return;
    for (const waiter of drainWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  /**
   * Chờ các tin đang xử lý chạy xong (dùng khi shutdown).
   * @param {number} [timeoutMs]
   * @returns {Promise<number>} số tin còn lại khi hết giờ (0 = đã sạch)
   */
  async function drain(timeoutMs = 10_000) {
    if (queueDepth === 0) return 0;
    /** @type {Promise<void>} */
    const drained = new Promise((resolve) => {
      /** @type {() => void} */
      const done = () => resolve();
      /** @type {{resolve: () => void, timer: NodeJS.Timeout}} */
      const waiter = {
        resolve: done,
        timer: setTimeout(() => {
          const index = drainWaiters.indexOf(waiter);
          if (index >= 0) drainWaiters.splice(index, 1);
          done();
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      drainWaiters.push(waiter);
    });
    await drained;
    return queueDepth;
  }

  return { handle, enqueue, pending, drain, seenSize: () => seen.size };
}

export const __test__ = { findBreak, planAttemptBudget };
