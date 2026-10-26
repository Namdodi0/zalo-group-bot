import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { __test__ as agentTest, createAgent } from '../src/ai/agent.js';
import { createToolRuntime } from '../src/ai/tools.js';
import { createCommands } from '../src/commands/index.js';
import { createContextStore } from '../src/context/store.js';
import { createMetrics } from '../src/metrics.js';
import { makeConfig, silentLogger, textEvent } from '../test-utils/helpers.js';

/**
 * @param {{replies?: any[], configOverrides?: Record<string, any>, tavily?: any, nimError?: any, delayMs?: number, deltaText?: string}} [options]
 */
async function setup(options = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-bot-test-'));
  const config = makeConfig({ context: { dir }, ...(options.configOverrides ?? {}) });
  const metrics = createMetrics();
  const store = createContextStore({ dir, logger: silentLogger, debounceMs: 2 });
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
  const target = {
    alias: 'deepseek',
    provider: 'deepseek',
    model: 'deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
  };
  async function reply(input) {
    nimCalls.push(input);
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (options.nimError) throw options.nimError;
    if (options.deltaText && input.onDelta) await input.onDelta(options.deltaText);
    const item = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return {
      content: item.content ?? '',
      toolCalls: item.toolCalls ?? [],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
      latencyMs: 1,
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
    logger: silentLogger,
    metrics,
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
    logger: silentLogger,
  });
  const agent = createAgent({ config, logger: silentLogger, metrics, zalo, llm, store, tools, commands, stickers });

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

test('ảnh của người dùng được đưa vào messages dạng image_url', async () => {
  const { agent, nimCalls } = await setup();
  await agent.handle(
    textEvent('', {
      kind: 'image',
      imageUrl: 'https://example.com/cat.png',
      eventName: 'message.image.received',
    }),
  );
  const messages = nimCalls[0].messages;
  const last = messages.at(-1);
  assert.ok(Array.isArray(last.content));
  assert.equal(last.content[1].type, 'image_url');
  assert.equal(last.content[1].image_url.url, 'https://example.com/cat.png');
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

test('queue đầy thì bỏ tin và báo bận', async () => {
  const { agent, sent } = await setup({ delayMs: 40, configOverrides: { maxQueueDepth: 1 } });
  const first = agent.enqueue(textEvent('một'));
  const second = agent.enqueue(textEvent('hai'));
  await Promise.all([first, second]);
  assert.ok(sent.some((message) => /nhiều tin/.test(message.text)));
});

test('injectTimeContext thêm giờ vào tin user cuối', () => {
  const messages = [
    { role: 'system', content: 'static' },
    { role: 'user', content: 'hi' },
  ];
  agentTest.injectTimeContext(messages, new Date(2026, 9, 26, 18, 0, 0));
  assert.match(messages[1].content, /Thời gian hiện tại/);
  assert.equal(messages[0].content, 'static');
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
