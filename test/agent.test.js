import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __test__ as agentTest, createAgent } from '../src/ai/agent.js';
import { LLM_ERROR, LlmError } from '../src/ai/llm/errors.js';
import { createToolRuntime } from '../src/ai/tools.js';
import { createCommands } from '../src/commands/index.js';
import { createCompactionEngine } from '../src/context/compaction/engine.js';
import { createContextStore } from '../src/context/store.js';
import { createMetrics } from '../src/metrics.js';
import { makeConfig, silentLogger, textEvent } from '../test-utils/helpers.js';

/**
 * @param {{replies?: any[], configOverrides?: Record<string, any>, tavily?: any, nimError?: any, delayMs?: number, deltaText?: string, logger?: any}} [options]
 */
async function setup(options = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-bot-test-'));
  const config = makeConfig({
    ...(options.configOverrides ?? {}),
    context: { dir, ...(options.configOverrides?.context ?? {}) },
  });
  const metrics = createMetrics();
  const logger = options.logger ?? silentLogger;
  const store = createContextStore({ dir, logger, debounceMs: 2 });
  await store.init();

  /** @type {any[]} */
  const sent = [];
  /** @type {string[]} */
  const events = [];
  /** @type {any[]} */
  const sentStickers = [];
  const zalo = {
    displayName: 'Bot deepseek',
    sendMessage: async (chatId, text) => {
      events.push('send');
      sent.push({ chatId, text });
      return { ok: true };
    },
    sendPhoto: async (chatId, url, caption) => {
      sent.push({ chatId, text: caption, photo: url });
      return { ok: true };
    },
    sendSticker: async (chatId, stickerId) => {
      sentStickers.push({ chatId, stickerId });
      return { ok: true };
    },
    sendChatAction: async () => ({ ok: true }),
    startTyping: () => async () => {
      events.push('typing:stop');
    },
    stopAllTyping: () => {},
  };

  /** @type {any[]} */
  const nimCalls = [];
  const replies = options.replies ?? [{ content: 'Xin chào 👋', toolCalls: [] }];
  let index = 0;
  let overflowed = false;
  const target = {
    alias: 'deepseek',
    provider: 'deepseek',
    model: 'deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
  };
  async function reply(input) {
    nimCalls.push(input);
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (options.overflowFirst && !overflowed) {
      overflowed = true;
      throw new LlmError(LLM_ERROR.CONTEXT_WINDOW_EXCEEDED, 'maximum context length exceeded', { status: 400 });
    }
    if (options.nimError) throw options.nimError;
    if (options.deltaText && input.onDelta) await input.onDelta(options.deltaText);
    const item = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return {
      content: item.content ?? '',
      reasoning: item.reasoning ?? '',
      toolCalls: item.toolCalls ?? [],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
      latencyMs: 1,
      completionTokens: 10,
      completionMs: 1,
      aborted: false,
    };
  }
  const llm = {
    resolve: () => target,
    find: () => target,
    list: () => [target],
    fallbackAlias: 'nim-light',
    chat: (input) => reply(input),
    chatWith: (_alias, input) => reply(input),
    async warmup() {
      return 1;
    },
  };

  const stickers = {
    find: (query) => (String(query).includes('chào') ? { id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' } : null),
    random: () => ({ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' }),
    list: () => [{ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi', tags: ['chào'] }],
    curated: () => [{ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi', tags: ['chào'] }],
    size: () => 1,
  };

  const tools = createToolRuntime({
    config,
    tavily: options.tavily ?? null,
    zalo,
    validator: { validate: async () => ({ ok: true }) },
    stickers,
    logger,
    metrics,
  });
  const compaction = createCompactionEngine({
    config,
    logger,
    metrics,
    summarize: async () => 'tóm tắt thử',
  });
  const commands = createCommands({
    config,
    store,
    metrics,
    zalo,
    http: {
      stateOf: () => ({ failures: 0, open: false, openedUntil: 0 }),
      listStates: () => [],
    },
    models: llm,
    stickers,
    logger,
    compaction,
  });
  const agent = createAgent({ config, logger, metrics, zalo, llm, store, tools, commands, stickers, compaction });

  return { agent, sent, sentStickers, events, nimCalls, store, config, metrics, dir };
}

test('trả lời trong group, strip mention, lưu context', async () => {
  const { agent, sent, store } = await setup();
  await agent.handle(textEvent('@Bot deepseek chào bạn'));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'chat-1');
  assert.match(sent[0].text, /Xin chào/);

  const record = await store.get('chat-1');
  assert.equal(record.turns, 1);
  assert.equal(record.messages.length, 2);
  assert.equal(record.messages[0].text, 'Nam: chào bạn');
  assert.equal(record.messages[1].role, 'assistant');
});

test('dedupe theo message_id', async () => {
  const { agent, sent } = await setup();
  const event = textEvent('chào', { messageId: 'same-id' });
  await agent.handle(event);
  await agent.handle(event);
  assert.equal(sent.length, 1);
});

test('bỏ qua tin nhắn của bot', async () => {
  const { agent, sent } = await setup();
  await agent.handle(textEvent('chào', { isBot: true }));
  assert.equal(sent.length, 0);
});

test('chat ngoài allowlist bị bỏ qua', async () => {
  const { agent, sent } = await setup({ configOverrides: { allowedChatIds: ['other-chat'] } });
  await agent.handle(textEvent('chào'));
  assert.equal(sent.length, 0);
});

test('chia câu trả lời dài thành nhiều tin, tối đa maxMessagesPerReply', async () => {
  const { agent, sent } = await setup({ replies: [{ content: 'A'.repeat(5000) }] });
  await agent.handle(textEvent('viết dài vào'));
  assert.equal(sent.length, 3);
  for (const message of sent) assert.ok(message.text.length <= 1910, `dài ${message.text.length}`);
});

test('/help xử lý trước model', async () => {
  const { agent, sent, nimCalls } = await setup();
  await agent.handle(textEvent('/help'));
  assert.equal(nimCalls.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\/status/);
});

test('ảnh người dùng gửi chỉ được ghi chú, không gửi image_url', async () => {
  const { agent, nimCalls } = await setup();
  await agent.handle(
    textEvent('', {
      kind: 'image',
      imageUrl: 'https://example.com/cat.png',
      eventName: 'message.image.received',
    }),
  );
  const messages = nimCalls[0].messages;
  assert.equal(messages.some((message) => Array.isArray(message.content)), false);
  assert.match(String(messages.at(-1).content), /Người dùng đã gửi một ảnh/);
});

test('ảnh gửi kèm chữ được ghi chú, nội dung ảnh không lên model', async () => {
  const { agent, nimCalls } = await setup();
  await agent.handle(textEvent('xem ảnh này', { imageUrl: 'https://example.com/cat.png' }));
  const messages = nimCalls[0].messages;
  assert.equal(messages.some((message) => Array.isArray(message.content)), false);
  const last = String(messages.at(-1).content);
  assert.match(last, /xem ảnh này/);
  assert.match(last, /gửi kèm ảnh/);
});

test('tool call web_search rồi trả lời kèm nguồn', async () => {
  const tavily = {
    search: async () => ({
      results: [{ title: 'Giá vàng', url: 'https://vnexpress.net/abc', content: 'Giá vàng tăng' }],
      images: [],
    }),
  };
  const { agent, sent, nimCalls } = await setup({
    tavily,
    replies: [
      { toolCalls: [{ id: 'call-1', name: 'web_search', arguments: { query: 'giá vàng' }, rawArguments: '{"query":"giá vàng"}' }] },
      { content: 'Giá vàng hôm nay tăng (https://vnexpress.net/abc)' },
    ],
  });

  await agent.handle(textEvent('@Bot deepseek giá vàng hôm nay?'));
  assert.equal(nimCalls.length, 2);
  assert.equal(nimCalls[1].messages.some((message) => message.role === 'tool'), true);
  assert.match(sent.at(-1).text, /vnexpress/);
});

test('lỗi model trả lời xin lỗi thay vì crash', async () => {
  const { agent, sent } = await setup({ nimError: new Error('boom') });
  await agent.handle(textEvent('chào'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Xin lỗi/);
});

test('tắt typing TRƯỚC khi gửi tin đầu tiên', async () => {
  const { agent, events } = await setup({ configOverrides: { typing: true } });
  await agent.handle(textEvent('chào'));
  assert.equal(events[0], 'typing:stop');
  assert.ok(events.includes('send'));
});

test('không giới hạn số tin trả lời khi MAX_MESSAGES_PER_REPLY=0', async () => {
  const { agent, sent } = await setup({
    replies: [{ content: 'A'.repeat(12_000) }],
    configOverrides: { maxMessagesPerReply: 0 },
  });
  await agent.handle(textEvent('viết dài vào'));
  assert.ok(sent.length >= 7, `chỉ gửi ${sent.length} tin`);
});

test('nhận sticker thì trả lại đúng sticker (echo)', async () => {
  const { agent, sentStickers, sent } = await setup();
  await agent.handle(
    textEvent('', {
      kind: 'sticker',
      sticker: '0e078a2fb66a5f34067b',
      eventName: 'message.sticker.received',
    }),
  );
  assert.equal(sentStickers.length, 1);
  assert.equal(sentStickers[0].stickerId, '0e078a2fb66a5f34067b');
  assert.equal(sent.length, 0);
});

test('/sticker gửi sticker theo cảm xúc', async () => {
  const { agent, sentStickers } = await setup();
  await agent.handle(textEvent('/sticker chào'));
  assert.equal(sentStickers.length, 1);
  assert.equal(sentStickers[0].stickerId, 'd8fa8021bc64553a0c75');
});

test('vẫn giữ câu hỏi khi model lỗi', async () => {
  const { agent, store } = await setup({ nimError: new Error('boom') });
  await agent.handle(textEvent('chào'));
  const record = await store.get('chat-1');
  assert.equal(record.messages[0].role, 'user');
  assert.match(String(record.messages[0].text), /chào/);
  assert.equal(record.turns, 1);
});

test('PROGRESSIVE=on gửi tách đoạn sớm', async () => {
  const head = `${'a'.repeat(140)}. `;
  const { agent, sent } = await setup({
    replies: [{ content: `${head}phần còn lại` }],
    deltaText: head,
    configOverrides: { progressive: 'on' },
  });
  await agent.handle(textEvent('kể chuyện dài'));
  assert.ok(sent.length >= 2, `chỉ gửi ${sent.length} tin`);
  assert.match(sent[0].text, /^a+\./);
});

test('meta.split=off gộp trả lời vào một tin dù PROGRESSIVE=on', async () => {
  const head = `${'a'.repeat(140)}. `;
  const { agent, sent, store } = await setup({
    replies: [{ content: `${head}phần còn lại` }],
    deltaText: head,
    configOverrides: { progressive: 'on' },
  });
  const record = await store.get('chat-1');
  record.meta.split = 'off';
  await agent.handle(textEvent('kể chuyện dài'));
  assert.equal(sent.length, 1, `gửi ${sent.length} tin`);
  assert.match(sent[0].text, /phần còn lại/);
});

test('dedupe bền: message_id đã lưu trong context thì bỏ qua', async () => {
  const { agent, sent, store } = await setup();
  const record = await store.get('chat-1');
  record.seen = ['msg-old'];
  await agent.handle(textEvent('chào lại', { messageId: 'msg-old' }));
  assert.equal(sent.length, 0);
});

test('USER_RATE_LIMIT_PER_MINUTE chặn spam theo người gửi', async () => {
  const { agent, sent } = await setup({ configOverrides: { userRateLimitPerMinute: 1 } });
  await agent.handle(textEvent('một'));
  await agent.handle(textEvent('hai'));
  assert.equal(sent.length, 1);
});

test('drain chờ tin đang xử lý gửi xong', async () => {
  const { agent, sent } = await setup({ delayMs: 60 });
  const task = agent.enqueue(textEvent('chờ tôi'));
  const left = await agent.drain(5000);
  assert.equal(left, 0);
  await task;
  assert.equal(sent.length, 1);
});

test('tool round không làm mất phần trả lời cuối', async () => {
  const head = `${'a'.repeat(140)}. `;
  const { agent, sent } = await setup({
    replies: [
      { content: head, toolCalls: [{ id: 'c1', name: 'web_search', arguments: { query: 'x' } }] },
      { content: 'câu trả lời cuối' },
    ],
    deltaText: head,
    configOverrides: { progressive: 'on' },
  });
  await agent.handle(textEvent('tìm giúp'));
  assert.ok(
    sent.some((message) => /câu trả lời cuối/.test(message.text)),
    `sent=${JSON.stringify(sent)}`,
  );
});

test('MAX_MESSAGES_PER_REPLY=1 thì không tách sớm, không mất phần còn lại', async () => {
  const head = `${'b'.repeat(140)}. `;
  const { agent, sent } = await setup({
    replies: [{ content: `${head}phần cuối` }],
    deltaText: head,
    configOverrides: { progressive: 'on', maxMessagesPerReply: 1 },
  });
  await agent.handle(textEvent('kể chuyện'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /phần cuối/);
});

test('queue đầy thì bỏ tin và báo bận', async () => {
  const { agent, sent } = await setup({ delayMs: 40, configOverrides: { maxQueueDepth: 1 } });
  const first = agent.enqueue(textEvent('một'));
  const second = agent.enqueue(textEvent('hai'));
  await Promise.all([first, second]);
  assert.ok(sent.some((message) => /nhiều tin/.test(message.text)));
});

test('context thời gian: message user riêng, bền vững và không sửa lượt user', async () => {
  const { agent, store } = await setup({ replies: [{ content: 'A' }, { content: 'B' }] });
  await agent.handle(textEvent('hôm nay thế nào', { messageId: 'm1' }));

  const record = await store.get('chat-1');
  const timeEntries = record.messages.filter((m) => m.kind === 'context' && m.source === 'runtime:time');
  assert.equal(timeEntries.length, 1);
  assert.match(timeEntries[0].text, /Thời gian hiện tại/);
  const userTurn = record.messages.find((m) => m.kind === 'turn' && m.role === 'user');
  assert.equal(userTurn.text.includes('Thời gian hiện tại'), false);
});

test('context thời gian được refresh, không nhân đôi qua các lượt', async () => {
  const { agent, store } = await setup({ replies: [{ content: 'A' }, { content: 'B' }] });
  await agent.handle(textEvent('hôm nay thế nào', { messageId: 'm1' }));
  await agent.handle(textEvent('mai đi học không', { messageId: 'm2' }));

  const record = await store.get('chat-1');
  const timeEntries = record.messages.filter((m) => m.kind === 'context' && m.source === 'runtime:time');
  assert.equal(timeEntries.length, 1);
});

test('context thời gian biến mất khi lượt mới không nhắc mốc thời gian', async () => {
  const { agent, store } = await setup({ replies: [{ content: 'A' }, { content: 'B' }] });
  await agent.handle(textEvent('hôm nay thế nào', { messageId: 'm1' }));
  await agent.handle(textEvent('giải thích TCP', { messageId: 'm2' }));

  const record = await store.get('chat-1');
  assert.equal(record.messages.some((m) => m.kind === 'context' && m.source === 'runtime:time'), false);
});

test('câu hỏi thường không chèn ngày giờ vào prompt gửi model', async () => {
  const { agent, nimCalls } = await setup();
  await agent.handle(textEvent('giải thích TCP'));
  const lastUser = [...nimCalls.at(-1).messages].reverse().find((message) => message.role === 'user');
  assert.equal(lastUser.content.includes('Thời gian hiện tại'), false);
  assert.equal(lastUser.content.includes('Độ dài'), false);
});

test('yêu cầu ngắn không chèn ghi chú độ dài vào prompt gửi model', async () => {
  const { agent, nimCalls } = await setup();
  await agent.handle(textEvent('giải thích TCP ngắn thôi'));
  const lastUser = [...nimCalls.at(-1).messages].reverse().find((message) => message.role === 'user');
  assert.equal(lastUser.content.includes('Độ dài'), false);
});

test('câu hỏi có mốc thời gian: payload có message context thời gian', async () => {
  const { agent, nimCalls } = await setup();
  await agent.handle(textEvent('hôm nay thế nào'));
  const messages = nimCalls.at(-1).messages;
  assert.ok(
    messages.some((message) => typeof message.content === 'string' && message.content.includes('Thời gian hiện tại')),
  );
});

test('context overflow: nén context rồi thử lại, không báo lỗi cho user', async () => {
  const { agent, sent, store } = await setup({
    overflowFirst: true,
    replies: [{ content: 'Đã trả lời sau khi nén' }],
    configOverrides: { context: { keepRecent: 4 } },
  });
  const record = await store.get('chat-1', { chatType: 'GROUP' });
  for (let index = 0; index < 16; index += 1) {
    record.messages.push({
      role: index % 2 ? 'assistant' : 'user',
      kind: 'turn',
      text: `tin cũ ${index}`,
      ts: index,
    });
  }
  store.touch('chat-1');

  await agent.handle(textEvent('câu hỏi mới', { messageId: 'overflow-1' }));

  assert.match(sent.at(-1).text, /sau khi nén/);
  const updated = await store.get('chat-1');
  assert.equal(updated.messages.some((message) => message.kind === 'summary'), true);
});

test('lượt 2 gửi kèm tin nhắn user + assistant của lượt 1 lên API', async () => {
  const { agent, nimCalls } = await setup({
    replies: [{ content: 'Chào Nam' }, { content: 'Bạn tên Nam' }],
  });

  await agent.handle(textEvent('mình tên Nam'));
  await agent.handle(textEvent('mình tên gì'));

  const payload = nimCalls.at(-1).messages;
  assert.equal(
    payload.some((message) => message.role === 'user' && String(message.content).includes('mình tên Nam')),
    true,
  );
  assert.equal(
    payload.some((message) => message.role === 'assistant' && String(message.content).includes('Chào Nam')),
    true,
  );
  // Câu hỏi mới nhất vẫn nằm cuối payload.
  assert.match(String(payload.at(-1).content), /mình tên gì/);
});

test('log console hiện tin user, tin bot, tên model, tok/s và thinking', async () => {
  /** @type {string[]} */
  const lines = [];
  const capture = {
    debug: (msg, fields) => lines.push(`debug ${msg} ${JSON.stringify(fields ?? {})}`),
    info: (msg, fields) => lines.push(`info ${msg} ${JSON.stringify(fields ?? {})}`),
    warn: () => {},
    error: () => {},
  };
  capture.child = () => capture;

  const { agent } = await setup({
    logger: capture,
    replies: [{ content: 'Chào Nam, khỏe không?', reasoning: 'Người dùng tên Nam.' }],
  });
  await agent.handle(textEvent('mình tên Nam'));

  const log = lines.join('\n');
  assert.match(log, /💬 Nam: mình tên Nam/);
  assert.match(log, /🧠 thinking: Người dùng tên Nam\./);
  assert.match(log, /🤖 bot: Chào Nam, khỏe không\?/);
  assert.match(log, /✅ replied · deepseek-flash · 10000 tok\/s/);
  assert.match(log, /"model":"deepseek-flash"/);
  assert.match(log, /"tps":10000/);
});

test('findBreak cắt ngay sau dấu câu, không lặp dấu', () => {
  const buffer = `${'a'.repeat(100)}. Phần tiếp theo`;
  const cut = agentTest.findBreak(buffer);
  assert.equal(buffer.slice(0, cut), `${'a'.repeat(100)}.`);
  assert.equal(buffer.slice(cut), ' Phần tiếp theo');

  const paragraph = `${'b'.repeat(80)}\n\nĐoạn mới`;
  assert.equal(paragraph.slice(0, agentTest.findBreak(paragraph)), `${'b'.repeat(80)}\n\n`);

  // không cắt ngay sau số thứ tự trơ trọi
  const danglingList = `${'c'.repeat(120)}\n2. `;
  const danglingCut = agentTest.findBreak(danglingList);
  assert.equal(danglingCut, 121);
  assert.equal(danglingList.slice(0, danglingCut).includes('2.'), false);
});
