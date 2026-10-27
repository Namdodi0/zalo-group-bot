import { buildMessages } from '../context/builder.js';
import { createCalibrator } from '../context/tokens.js';
import { CircuitOpenError, HttpError } from '../http.js';
import {
  chunkText,
  formatNow,
  normalizeWhitespace,
  prepareOutgoing,
  stripMention,
  truncate,
} from '../text/format.js';
import {
  SUMMARY_SYSTEM_PROMPT,
  buildLengthHint,
  buildSearchContext,
  buildSummaryInput,
  buildSystemPrompt,
} from './prompt.js';

const MAX_CONCURRENT_CHATS = 4;
const MAX_TOOL_ROUNDS = 3;
const CHUNK_LIMIT = 1900;

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {number} value @param {number} min @param {number} max */
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Lỗi NIM có nên thử lại không (timeout, 429, 5xx).
 * @param {unknown} error
 */
function isRetryableNimError(error) {
  if (!(error instanceof HttpError)) return false;
  if (error.status === 0) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

/**
 * Tin nhắn có nhắc mốc thời gian tương đối mới cần biết "hôm nay là ngày nào".
 * Câu hỏi thường không chèn giờ để model không nhắc lại ngày giờ vô cớ.
 */
const TIME_HINT_RE =
  /(?:^|[\s,.;:!?()"'“”])(?:hôm nay|hôm qua|hôm kia|hôm trước|hôm bữa|hôm nào|ngày mai|ngày mốt|sáng mai|chiều mai|tối mai|sáng nay|trưa nay|chiều nay|tối nay|đêm nay|tuần này|tuần sau|tuần trước|tuần tới|tuần rồi|tháng này|tháng sau|tháng trước|tháng tới|tháng rồi|năm nay|năm sau|năm trước|năm rồi|cuối tuần|đầu tuần|cuối tháng|đầu tháng|bây giờ|hiện tại|lúc này|mấy giờ|giờ nào|giờ rồi|thứ mấy|ngày mấy|tháng mấy|bao giờ|khi nào|bao lâu|deadline|hạn chót|hạn nộp|mai|mốt|noel|giáng sinh|tết|sinh nhật)(?=$|[\s,.;:!?()"'“”])/i;

/** @param {string} text */
function needsTimeContext(text) {
  return TIME_HINT_RE.test(String(text ?? ''));
}

/**
 * Chèn mốc thời gian vào cuối tin nhắn user (bản copy gửi model, không lưu vào context).
 * Giữ system prompt tĩnh để prefix không đổi giữa các lượt.
 * @param {any[]} messages
 * @param {Date} [date]
 * @param {string[]} [notes] ghi chú thêm cho lượt này (vd nhắc độ dài)
 * @param {{includeTime?: boolean}} [options] `includeTime: false` → chỉ chèn notes
 */
function injectTimeContext(messages, date = new Date(), notes = [], options = {}) {
  /** @type {string[]} */
  const lines = [];
  if (options.includeTime !== false) {
    lines.push(
      `[Thời gian hiện tại: ${formatNow(date)} — chỉ dùng để quy đổi mốc thời gian tương đối, không nhắc lại ngày giờ trừ khi người dùng hỏi]`,
    );
  }
  for (const note of notes) {
    const clean = String(note ?? '').trim();
    if (clean) lines.push(`[${clean}]`);
  }
  if (!lines.length) return messages;
  const stamp = `\n\n${lines.join('\n')}`;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') {
      message.content = `${message.content}${stamp}`;
    } else if (Array.isArray(message.content)) {
      const textPart = message.content.find((part) => part?.type === 'text');
      if (textPart) textPart.text = `${textPart.text ?? ''}${stamp}`;
      else message.content.push({ type: 'text', text: stamp.trim() });
    }
    return messages;
  }
  return messages;
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
 * @param {{config: any, logger: import('../logger.js').Logger, metrics: any, zalo: ReturnType<typeof import('../zalo/client.js').createZaloClient>, llm: ReturnType<typeof import('./router.js').createModelRouter>, store: ReturnType<typeof import('../context/store.js').createContextStore>, tools: ReturnType<typeof import('./tools.js').createToolRuntime>, commands: ReturnType<typeof import('../commands/index.js').createCommands>, stickers?: ReturnType<typeof import('./stickers.js').createStickerStore>, http?: ReturnType<typeof import('../http.js').createHttp>}} deps
 */
export function createAgent(deps) {
  const { config, logger, metrics, zalo, llm, store, tools, commands, stickers } = deps;
  const calibrator = createCalibrator();

  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {Map<string, Promise<void>>} */
  const chatQueues = new Map();

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
            emoji: config.emoji,
            parseMode: config.zalo.parseMode,
          });
          if (!payload) return;
          await zalo.sendMessage(chatId, payload);
          sent += 1;
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
   * @param {import('../context/store.js').StoredMessage[]} messages
   * @param {number} deadline
   */
  async function summarize(messages, deadline, record) {
    if (!messages.length) return '';
    const timeout = clamp(deadline - Date.now(), 3000, 15_000);
    const response = await llm.chat({
      record,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: buildSummaryInput(messages) },
      ],
      reasoning: 'none',
      temperature: 0.3,
      maxTokens: 200,
      timeoutMs: timeout,
      signal: AbortSignal.timeout(timeout),
    });
    return truncate((response.content ?? '').trim(), 900);
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
    const effectiveText = rawText || (event.imageUrl ? 'Hãy mô tả ảnh này.' : '');
    if (!effectiveText) return;

    const storedText =
      event.chatType === 'GROUP' && effectiveText
        ? `${event.senderName}: ${effectiveText}`
        : effectiveText;

    /** @type {import('../context/store.js').StoredMessage} */
    const userTurn = {
      role: 'user',
      text: storedText,
      name: event.senderName,
      imageUrl: event.imageUrl ?? null,
      ts: Date.now(),
      messageId: event.messageId,
    };

    const tone = record?.meta?.tone ?? config.tone;
    const systemPrompt = buildSystemPrompt({
      botName: zalo.displayName || 'trợ lý AI',
      chatType: event.chatType,
      emoji: config.emoji,
      searchEnabled: config.search.enabled,
      imageEnabled: config.image.enabled,
      stickerEnabled: config.sticker.enabled,
      tone,
    });

    const reasoning = effectiveReasoning(record, effectiveText);
    const target = llm.resolve(record);
    const toolDefs = tools.definitions();
    const streaming = config.progressive !== 'off';
    // `on` = gửi tách đoạn sớm (khi có câu hoàn chỉnh); `auto` = chỉ khi chờ lâu.
    const flushAfterMs = config.progressive === 'on' ? 0 : config.progressiveAfterMs;
    const minHeadChars = config.progressive === 'on' ? 80 : 160;

    // Lưu lượt của user NGAY (trước khi gọi model) để không mất câu hỏi nếu crash/timeout.
    record.messages.push(userTurn);
    record.turns = (record.turns ?? 0) + 1;
    store.touch(event.chatId);

    const buildAll = () =>
      buildMessages({
        systemPrompt,
        record,
        maxTokens: config.context.maxTokens,
        maxMessages: config.context.maxMessages,
        maxCharsPerMessage: config.context.maxCharsPerMessage,
        maxImages: config.context.maxImages,
        calibrator,
      });

    let built = buildAll();

    if (built.needsSummary && config.context.summary) {
      const keep = 8;
      const older = record.messages.slice(0, Math.max(0, record.messages.length - keep));
      if (older.length) {
        try {
          const summary = await summarize(older, deadline, record);
          if (summary) {
            record.summary = truncate(
              normalizeWhitespace(`${record.summary ? `${record.summary} ` : ''}${summary}`),
              1200,
            );
            record.messages = record.messages.slice(-keep);
            built = buildAll();
            metrics.inc('context.summarized');
          }
        } catch (error) {
          logger.warn('summarize failed, fallback to trimming', {
            error: String(/** @type {any} */ (error)?.message ?? error),
          });
        }
      }
    }

    /** @type {any[]} */
    const messages = [...built.messages];
    // Nhắc độ dài trong chính lượt này: system prompt một mình không đủ, model rất
    // hay trả lời 1 câu dù prompt đã dặn "đủ ý".
    injectTimeContext(messages, new Date(), [buildLengthHint(effectiveText, { tone })], {
      includeTime: needsTimeContext(effectiveText),
    });

    if (options.forceSearch) {
      const search = await tools.run(
        'web_search',
        { query: options.forceSearch },
        { chatId: event.chatId, deadline },
      );
      messages.push({ role: 'system', content: buildSearchContext(options.forceSearch, search.text) });
    }

    // Bằng chứng context có được gửi lên API: bật LOG_LEVEL=debug sẽ thấy số message
    // (đã gồm lịch sử) và số ký tự của cả payload ở mỗi lượt.
    logger.debug('llm payload', {
      chatId: event.chatId,
      messages: messages.length,
      kept: built.keptMessages,
      dropped: built.dropped,
      estTokens: built.estimatedTokens,
      chars: messages.reduce(
        (sum, message) =>
          sum + (typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length),
        0,
      ),
    });

    let streamBuffer = '';
    let emitted = 0;
    let flushed = false;

    const onDelta = (delta) => {
      if (!streaming || flushed) return;
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
    // Thống kê LLM của lượt này để log: tổng thời gian gọi, thời gian sinh thật (đã trừ TTFT),
    // số token sinh ra → tok/s. Cộng dồn qua các vòng tool call.
    let llmMs = 0;
    let completionMs = 0;
    let completionTokens = 0;

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

      // 2 lần thử: mỗi lần chỉ dùng nửa ngân sách còn lại để còn cửa retry (NIM hay chập chờn).
      for (let attempt = 0; attempt < 2 && !response; attempt += 1) {
        const left = deadline - Date.now();
        if (left < 1500) break;
        // TTFT tối đa ~9s: nếu NIM treo thì bỏ và retry sớm thay vì chờ hết ngân sách.
        const attemptTimeout = Math.max(4000, Math.min(config.ai.timeoutMs, Math.floor(left / 2), 9000));
        // Đo cả lần gọi thất bại: llmMs là tổng thời gian thực sự tiêu vào LLM.
        const callStarted = Date.now();
        try {
          response = await llm.chat({
            record,
            messages,
            tools: toolDefs.length ? toolDefs : undefined,
            reasoning,
            temperature: config.ai.temperature,
            maxTokens: config.ai.maxTokens,
            stream: streaming,
            onDelta,
            ttftMs: attemptTimeout,
            timeoutMs: streaming ? left : Math.max(4000, Math.min(config.ai.timeoutMs, left)),
            signal: AbortSignal.timeout(left),
          });
          llmMs += Date.now() - callStarted;
        } catch (error) {
          llmMs += Date.now() - callStarted;
          lastError = error;
          if (!isRetryableNimError(error) || attempt === 1) break;
          metrics.inc('llm.retries');
          logger.warn('nim call failed, retrying', {
            attempt: attempt + 1,
            provider: target.provider,
            model: target.model,
            status: /** @type {any} */ (error)?.status,
            error: String(/** @type {any} */ (error)?.message ?? error),
            icon: '🔁',
          });
          await sleep(400 * (attempt + 1));
        }
      }

      // Fallback cuối: bỏ tool để vẫn có câu trả lời thay vì báo lỗi.
      if (!response) {
        let left = deadline - Date.now();
        if (left > 5000) {
          await sleep(800);
          left = deadline - Date.now();
        }
        if (left > 2000) {
          const fallbackStarted = Date.now();
          try {
            response = await llm.chatWith(llm.fallbackAlias, {
              messages,
              reasoning: 'none',
              temperature: config.ai.temperature,
              maxTokens: config.ai.maxTokens,
              stream: false,
              timeoutMs: Math.max(1500, Math.min(config.ai.timeoutMs, left - 500)),
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
        }
      }

      if (!response) {
        // Đã gửi được một phần (progressive) thì coi như xong phần đó.
        if (flushed) {
          aborted = true;
          break;
        }
        throw lastError ?? new Error('NIM không phản hồi');
      }

      completionMs += Number(response.completionMs ?? response.latencyMs ?? 0) || 0;
      completionTokens += Number(response.completionTokens ?? response.usage?.completion_tokens ?? 0) || 0;

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

        for (const call of response.toolCalls) {
          const started = Date.now();
          const result = await tools.run(call.name, call.arguments, { chatId: event.chatId, deadline });
          metrics.observe(`tool.${call.name}`, Date.now() - started);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: truncate(result.text, 4000),
          });
        }
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

    record.messages.push({
      role: 'assistant',
      text: truncate(normalizeWhitespace(finalText), 4000),
      ts: Date.now(),
      imageUrl: null,
    });
    store.touch(event.chatId);

    const duration = Date.now() - startedAt;
    const tps =
      completionTokens > 0 && completionMs > 0
        ? Math.round((completionTokens / (completionMs / 1000)) * 10) / 10
        : 0;
    metrics.observe('agent.reply', duration);
    metrics.inc('messages.replied');
    logger.info('replied', {
      chatId: event.chatId,
      ms: duration,
      llmMs,
      tps,
      tokens: completionTokens,
      chars: finalText.length,
      ...(aborted ? { aborted: true } : {}),
      messages: sender.sent(),
      kept: built.keptMessages,
      reasoning,
      model: target.alias,
      provider: target.provider,
      icon: '✅',
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
    logger.info('incoming message', {
      chatId: event.chatId,
      from: event.senderName,
      kind: event.kind,
      len: (event.text ?? '').length,
      icon: '💬',
    });
    const stopTyping = config.typing ? zalo.startTyping(event.chatId) : async () => {};

    try {
      const record = await store.get(event.chatId, { chatType: event.chatType });

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
    const previous = chatQueues.get(chatId) ?? Promise.resolve();
    const task = previous
      .then(() => acquire())
      .then(() => handle(event))
      .catch((error) => logger.error('queued handler crashed', { error }))
      .finally(() => {
        queueDepth = Math.max(0, queueDepth - 1);
        release();
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

  return { handle, enqueue, pending, seenSize: () => seen.size };
}

export const __test__ = { findBreak, clamp, injectTimeContext, needsTimeContext };
