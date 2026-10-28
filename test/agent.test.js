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
import { HttpError } from '../src/http.js';
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
  const replies = options.replies ?? [{ content: 'Hello 👋', toolCalls: [] }];
  let index = 0;
  let overflowed = false;
  const target = {
    alias: 'deepseek',
    provider: 'deepseek',
    model: 'deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
  };
  async function reply(input, viaFallback = false) {
    nimCalls.push(input);
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (options.overflowFirst && !overflowed) {
      overflowed = true;
      throw new LlmError(LLM_ERROR.CONTEXT_WINDOW_EXCEEDED, 'maximum context length exceeded', { status: 400 });
    }
    if (options.nimError) throw options.nimError;
    if (options.primaryError && !viaFallback) throw options.primaryError;
    if (options.fallbackError && viaFallback) throw options.fallbackError;
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
    fallbackFor: () => 'nim-light',
    chat: (input) => reply(input),
    chatWith: (_alias, input) => reply(input, true),
    async warmup() {
      return 1;
    },
  };

  const stickers = {
    find: (query) => (String(query).includes('greeting') ? { id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' } : null),
    random: () => ({ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi' }),
    list: () => [{ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi', tags: ['greeting'] }],
    curated: () => [{ id: 'd8fa8021bc64553a0c75', name: 'Anh Tre Say Hi', tags: ['greeting'] }],
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
    summarize: async () => 'test summary',
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

test('replies in a group, strips the mention, stores context', async () => {
  const { agent, sent, store } = await setup();
  await agent.handle(textEvent('@Bot deepseek hello there'));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'chat-1');
  assert.match(sent[0].text, /Hello/);

  const record = await store.get('chat-1');
  assert.equal(record.turns, 1);
  assert.equal(record.messages.length, 2);
  assert.equal(record.messages[0].text, 'Nam: hello there');
  assert.equal(record.messages[1].role, 'assistant');
});

test('dedupes by message_id', async () => {
  const { agent, sent } = await setup();
  const event = textEvent('hi', { messageId: 'same-id' });
  await agent.handle(event);
  await agent.handle(event);
  assert.equal(sent.length, 1);
});

test('skips messages sent by the bot', async () => {
  const { agent, sent } = await setup();
  await agent.handle(textEvent('hi', { isBot: true }));
  assert.equal(sent.length, 0);
});

test('chats outside the allowlist are skipped', async () => {
  const { agent, sent } = await setup({ configOverrides: { allowedChatIds: ['other-chat'] } });
  await agent.handle(textEvent('hi'));
  assert.equal(sent.length, 0);
});

test('splits a long reply into several messages, at most maxMessagesPerReply', async () => {
  const { agent, sent } = await setup({ replies: [{ content: 'A'.repeat(5000) }] });
  await agent.handle(textEvent('write something long'));
  assert.equal(sent.length, 3);
  for (const message of sent) assert.ok(message.text.length <= 1910, `long ${message.text.length}`);
});

test('/help is handled before the model', async () => {
  const { agent, sent, nimCalls } = await setup();
  await agent.handle(textEvent('/help'));
  assert.equal(nimCalls.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\/status/);
});

test('images sent by users are only noted, image_url is not sent', async () => {
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
  assert.match(String(messages.at(-1).content), /The user sent an image/);
});

test('an image sent with text is noted and image content never reaches the model', async () => {
  const { agent, nimCalls } = await setup();
  await agent.handle(textEvent('look at this image', { imageUrl: 'https://example.com/cat.png' }));
  const messages = nimCalls[0].messages;
  assert.equal(messages.some((message) => Array.isArray(message.content)), false);
  const last = String(messages.at(-1).content);
  assert.match(last, /look at this image/);
  assert.match(last, /attached an image/);
});

test('web_search tool call, then an answer with the source', async () => {
  const tavily = {
    search: async () => ({
      results: [{ title: 'Gold price', url: 'https://vnexpress.net/abc', content: 'Gold price rises' }],
      images: [],
    }),
  };
  const { agent, sent, nimCalls } = await setup({
    tavily,
    replies: [
      { toolCalls: [{ id: 'call-1', name: 'web_search', arguments: { query: 'gold price' }, rawArguments: '{"query":"gold price"}' }] },
      { content: 'Gold price is up today (https://vnexpress.net/abc)' },
    ],
  });

  await agent.handle(textEvent('@Bot deepseek gold price today?'));
  assert.equal(nimCalls.length, 2);
  assert.equal(nimCalls[1].messages.some((message) => message.role === 'tool'), true);
  assert.match(sent.at(-1).text, /vnexpress/);
});

test('model errors produce an apology instead of a crash', async () => {
  const { agent, sent } = await setup({ nimError: new Error('boom') });
  await agent.handle(textEvent('hi'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Sorry/);
});

test('stops typing BEFORE sending the first message', async () => {
  const { agent, events } = await setup({ configOverrides: { typing: true } });
  await agent.handle(textEvent('hi'));
  assert.equal(events[0], 'typing:stop');
  assert.ok(events.includes('send'));
});

test('no reply-message limit when MAX_MESSAGES_PER_REPLY=0', async () => {
  const { agent, sent } = await setup({
    replies: [{ content: 'A'.repeat(12_000) }],
    configOverrides: { maxMessagesPerReply: 0 },
  });
  await agent.handle(textEvent('write something long'));
  assert.ok(sent.length >= 7, `only sent ${sent.length} messages`);
});

test('an incoming sticker is echoed back unchanged', async () => {
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

test('/sticker sends a sticker for the given mood', async () => {
  const { agent, sentStickers } = await setup();
  await agent.handle(textEvent('/sticker greeting'));
  assert.equal(sentStickers.length, 1);
  assert.equal(sentStickers[0].stickerId, 'd8fa8021bc64553a0c75');
});

test('keeps the question when the model fails', async () => {
  const { agent, store } = await setup({ nimError: new Error('boom') });
  await agent.handle(textEvent('hi'));
  const record = await store.get('chat-1');
  assert.equal(record.messages[0].role, 'user');
  assert.match(String(record.messages[0].text), /hi/);
  assert.equal(record.turns, 1);
});

test('PROGRESSIVE=on sends split segments early', async () => {
  const head = `${'a'.repeat(140)}. `;
  const { agent, sent } = await setup({
    replies: [{ content: `${head}the rest` }],
    deltaText: head,
    configOverrides: { progressive: 'on' },
  });
  await agent.handle(textEvent('tell me a long story'));
  assert.ok(sent.length >= 2, `only sent ${sent.length} messages`);
  assert.match(sent[0].text, /^a+\./);
});

test('meta.split=off merges the reply into one message even with PROGRESSIVE=on', async () => {
  const head = `${'a'.repeat(140)}. `;
  const { agent, sent, store } = await setup({
    replies: [{ content: `${head}the rest` }],
    deltaText: head,
    configOverrides: { progressive: 'on' },
  });
  const record = await store.get('chat-1');
  record.meta.split = 'off';
  await agent.handle(textEvent('tell me a long story'));
  assert.equal(sent.length, 1, `sent ${sent.length} messages`);
  assert.match(sent[0].text, /the rest/);
});

test('durable dedupe: a message_id already stored in context is skipped', async () => {
  const { agent, sent, store } = await setup();
  const record = await store.get('chat-1');
  record.seen = ['msg-old'];
  await agent.handle(textEvent('hello again', { messageId: 'msg-old' }));
  assert.equal(sent.length, 0);
});

test('USER_RATE_LIMIT_PER_MINUTE blocks spam per sender', async () => {
  const { agent, sent } = await setup({ configOverrides: { userRateLimitPerMinute: 1 } });
  await agent.handle(textEvent('one'));
  await agent.handle(textEvent('two'));
  assert.equal(sent.length, 1);
});

test('drain waits for in-flight messages to finish sending', async () => {
  const { agent, sent } = await setup({ delayMs: 60 });
  const task = agent.enqueue(textEvent('wait for me'));
  const left = await agent.drain(5000);
  assert.equal(left, 0);
  await task;
  assert.equal(sent.length, 1);
});

test('a tool round does not lose the final part of the reply', async () => {
  const head = `${'a'.repeat(140)}. `;
  const { agent, sent } = await setup({
    replies: [
      { content: head, toolCalls: [{ id: 'c1', name: 'web_search', arguments: { query: 'x' } }] },
      { content: 'final answer' },
    ],
    deltaText: head,
    configOverrides: { progressive: 'on' },
  });
  await agent.handle(textEvent('search for me'));
  assert.ok(
    sent.some((message) => /final answer/.test(message.text)),
    `sent=${JSON.stringify(sent)}`,
  );
});

test('MAX_MESSAGES_PER_REPLY=1 does not split early and loses nothing', async () => {
  const head = `${'b'.repeat(140)}. `;
  const { agent, sent } = await setup({
    replies: [{ content: `${head}the ending` }],
    deltaText: head,
    configOverrides: { progressive: 'on', maxMessagesPerReply: 1 },
  });
  await agent.handle(textEvent('tell me a story'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /the ending/);
});

test('a full queue drops the message and reports busy', async () => {
  const { agent, sent } = await setup({ delayMs: 40, configOverrides: { maxQueueDepth: 1 } });
  const first = agent.enqueue(textEvent('one'));
  const second = agent.enqueue(textEvent('two'));
  await Promise.all([first, second]);
  assert.ok(sent.some((message) => /too many messages/.test(message.text)));
});

test('planAttemptBudget: non-streaming reserves 25% of the deadline for fallback', () => {
  const first = agentTest.planAttemptBudget({
    remainingMs: 30_000,
    attempt: 1,
    maxAttempts: 2,
    streaming: false,
    aiTimeoutMs: 15_000,
  });
  assert.equal(first.reserveMs, 7500);
  assert.equal(first.primaryMs, 22_500);
  assert.equal(first.timeoutMs, 11_250);
  assert.ok(first.ttftMs <= 9000);

  const second = agentTest.planAttemptBudget({
    remainingMs: 17_500,
    attempt: 2,
    maxAttempts: 2,
    streaming: false,
    aiTimeoutMs: 15_000,
  });
  assert.equal(second.timeoutMs, 13_125);
  assert.ok(second.reserveMs >= 2500);
});

test('planAttemptBudget: streaming still reserves room for the fallback', () => {
  const plan = agentTest.planAttemptBudget({
    remainingMs: 30_000,
    attempt: 1,
    maxAttempts: 2,
    streaming: true,
    aiTimeoutMs: 15_000,
  });
  assert.equal(plan.reserveMs, 7500);
  assert.equal(plan.primaryMs, 22_500);
  assert.equal(plan.timeoutMs, 22_500);
  assert.equal(plan.ttftMs, 9000);
});

test('planAttemptBudget: a streaming retry also leaves the fallback reserve', () => {
  const plan = agentTest.planAttemptBudget({
    remainingMs: 20_000,
    attempt: 2,
    maxAttempts: 2,
    streaming: true,
    aiTimeoutMs: 15_000,
  });
  assert.equal(plan.reserveMs, 5000);
  assert.equal(plan.timeoutMs, 15_000);
  assert.ok(20_000 - plan.timeoutMs >= 2500);
});

test('planAttemptBudget: a tight deadline gives a short attempt with no room for fallback', () => {
  const plan = agentTest.planAttemptBudget({
    remainingMs: 3000,
    attempt: 1,
    maxAttempts: 2,
    streaming: false,
    aiTimeoutMs: 15_000,
  });
  assert.equal(plan.reserveMs, 750);
  assert.ok(plan.reserveMs < 2500);
  assert.equal(plan.timeoutMs, 1500);
});

test('retryable primary failure: retry then fallback, the user still gets an answer', async () => {
  const { agent, sent, nimCalls } = await setup({
    primaryError: new HttpError('upstream down', { status: 503 }),
  });
  await agent.handle(textEvent('hi'));

  assert.equal(nimCalls.length, 3); // 2 primary attempts + 1 fallback
  assert.match(sent.at(-1).text, /Hello/);
});

test('budget abort is not retried: the remaining time goes to the fallback', async () => {
  const { agent, sent, nimCalls } = await setup({
    primaryError: new HttpError('nim:model aborted by caller', { status: 0, aborted: true }),
  });
  await agent.handle(textEvent('hi'));

  assert.equal(nimCalls.length, 2); // 1 primary attempt (no retry) + 1 fallback
  assert.match(sent.at(-1).text, /Hello/);
});

test('time context: a separate, durable user message that never alters the user turn', async () => {
  const { agent, store } = await setup({ replies: [{ content: 'A' }, { content: 'B' }] });
  await agent.handle(textEvent('h\u00f4m nay th\u1ebf n\u00e0o', { messageId: 'm1' }));

  const record = await store.get('chat-1');
  const timeEntries = record.messages.filter((m) => m.kind === 'context' && m.source === 'runtime:time');
  assert.equal(timeEntries.length, 1);
  assert.match(timeEntries[0].text, /Th\u1eddi gian hi\u1ec7n t\u1ea1i/);
  const userTurn = record.messages.find((m) => m.kind === 'turn' && m.role === 'user');
  assert.equal(userTurn.text.includes('Th\u1eddi gian hi\u1ec7n t\u1ea1i'), false);
});

test('time context is refreshed and never duplicated across turns', async () => {
  const { agent, store } = await setup({ replies: [{ content: 'A' }, { content: 'B' }] });
  await agent.handle(textEvent('h\u00f4m nay th\u1ebf n\u00e0o', { messageId: 'm1' }));
  await agent.handle(textEvent('mai \u0111i h\u1ecdc kh\u00f4ng', { messageId: 'm2' }));

  const record = await store.get('chat-1');
  const timeEntries = record.messages.filter((m) => m.kind === 'context' && m.source === 'runtime:time');
  assert.equal(timeEntries.length, 1);
});

test('time context disappears when the new turn mentions no time marker', async () => {
  const { agent, store } = await setup({ replies: [{ content: 'A' }, { content: 'B' }] });
  await agent.handle(textEvent('h\u00f4m nay th\u1ebf n\u00e0o', { messageId: 'm1' }));
  await agent.handle(textEvent('explain TCP', { messageId: 'm2' }));

  const record = await store.get('chat-1');
  assert.equal(record.messages.some((m) => m.kind === 'context' && m.source === 'runtime:time'), false);
});

test('ordinary questions do not inject date/time into the prompt sent to the model', async () => {
  const { agent, nimCalls } = await setup();
  await agent.handle(textEvent('explain TCP'));
  const lastUser = [...nimCalls.at(-1).messages].reverse().find((message) => message.role === 'user');
  assert.equal(lastUser.content.includes('Th\u1eddi gian hi\u1ec7n t\u1ea1i'), false);
  assert.equal(lastUser.content.includes('Length'), false);
});

test('short requests do not inject a length note into the prompt sent to the model', async () => {
  const { agent, nimCalls } = await setup();
  await agent.handle(textEvent('explain TCP briefly'));
  const lastUser = [...nimCalls.at(-1).messages].reverse().find((message) => message.role === 'user');
  assert.equal(lastUser.content.includes('Length'), false);
});

test('a question with a time marker: the payload has a time context message', async () => {
  const { agent, nimCalls } = await setup();
  await agent.handle(textEvent('h\u00f4m nay th\u1ebf n\u00e0o'));
  const messages = nimCalls.at(-1).messages;
  assert.ok(
    messages.some(
      (message) => typeof message.content === 'string' && message.content.includes('Th\u1eddi gian hi\u1ec7n t\u1ea1i'),
    ),
  );
});

test('context overflow: compacts the context then retries, no error shown to the user', async () => {
  const { agent, sent, store } = await setup({
    overflowFirst: true,
    replies: [{ content: 'Answered after compaction' }],
    configOverrides: { context: { keepRecent: 4 } },
  });
  const record = await store.get('chat-1', { chatType: 'GROUP' });
  for (let index = 0; index < 16; index += 1) {
    record.messages.push({
      role: index % 2 ? 'assistant' : 'user',
      kind: 'turn',
      text: `old message ${index}`,
      ts: index,
    });
  }
  store.touch('chat-1');

  await agent.handle(textEvent('new question', { messageId: 'overflow-1' }));

  assert.match(sent.at(-1).text, /after compaction/);
  const updated = await store.get('chat-1');
  assert.equal(updated.messages.some((message) => message.kind === 'summary'), true);
});

test('turn 2 sends turn 1 user and assistant messages to the API', async () => {
  const { agent, nimCalls } = await setup({
    replies: [{ content: 'Hi Nam' }, { content: 'Your name is Nam' }],
  });

  await agent.handle(textEvent('my name is Nam'));
  await agent.handle(textEvent('what is my name'));

  const payload = nimCalls.at(-1).messages;
  assert.equal(
    payload.some((message) => message.role === 'user' && String(message.content).includes('my name is Nam')),
    true,
  );
  assert.equal(
    payload.some((message) => message.role === 'assistant' && String(message.content).includes('Hi Nam')),
    true,
  );
  // The newest question is still last in the payload.
  assert.match(String(payload.at(-1).content), /what is my name/);
});

test('console log shows the user message, bot message, model name, tok/s and thinking', async () => {
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
    replies: [{ content: 'Hi Nam, how are you?', reasoning: 'The user is named Nam.' }],
  });
  await agent.handle(textEvent('my name is Nam'));

  const log = lines.join('\n');
  assert.match(log, /💬 Nam: my name is Nam/);
  assert.match(log, /🧠 thinking: The user is named Nam\./);
  assert.match(log, /🤖 bot: Hi Nam, how are you\?/);
  assert.match(log, /✅ replied · deepseek-flash · 10000 tok\/s/);
  assert.match(log, /"model":"deepseek-flash"/);
  assert.match(log, /"tps":10000/);
});

test('findBreak cuts right after punctuation without repeating the mark', () => {
  const buffer = `${'a'.repeat(100)}. Next part`;
  const cut = agentTest.findBreak(buffer);
  assert.equal(buffer.slice(0, cut), `${'a'.repeat(100)}.`);
  assert.equal(buffer.slice(cut), ' Next part');

  const paragraph = `${'b'.repeat(80)}\n\nNew paragraph`;
  assert.equal(paragraph.slice(0, agentTest.findBreak(paragraph)), `${'b'.repeat(80)}\n\n`);

  // do not cut right after a dangling list number
  const danglingList = `${'c'.repeat(120)}\n2. `;
  const danglingCut = agentTest.findBreak(danglingList);
  assert.equal(danglingCut, 121);
  assert.equal(danglingList.slice(0, danglingCut).includes('2.'), false);
});
