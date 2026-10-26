import test from 'node:test';
import assert from 'node:assert/strict';
import { DEEPSEEK_REASONING_MAP, createLlmClient } from '../src/ai/nim.js';
import { createSilentLogger } from '../src/logger.js';

const logger = createSilentLogger();

function fakeHttp(payloads, responseBody) {
  const http = {
    calls: [],
    async requestJson(url, opts) {
      http.calls.push({ url, payload: JSON.parse(opts.body) });
      return { status: 200, data: responseBody, headers: new Headers(), latencyMs: 1 };
    },
    async openStream() {
      throw new Error('not used');
    },
  };
  return http;
}

const standardResponse = {
  choices: [{ message: { content: 'Xin chào', role: 'assistant' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 0 } },
};

function makeClient(http, overrides = {}) {
  return createLlmClient({
    provider: 'nim',
    apiKey: 'k',
    baseUrl: 'https://nim.test/v1',
    model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    http,
    logger,
    ...overrides,
  });
}

test('DeepSeek map medium → high, none giữ none', async () => {
  const http = fakeHttp([], standardResponse);
  const client = makeClient(http, {
    provider: 'deepseek',
    reasoningMap: DEEPSEEK_REASONING_MAP,
    model: 'deepseek-flash',
  });
  await client.chat({ messages: [{ role: 'user', content: 'x' }], reasoning: 'medium' });
  assert.equal(http.calls[0].payload.reasoning_effort, 'high');
  await client.chat({ messages: [{ role: 'user', content: 'x' }], reasoning: 'none' });
  assert.equal(http.calls[1].payload.reasoning_effort, 'none');
  assert.equal(http.calls[1].payload.model, 'deepseek-flash');
});

test('không gửi max_tokens khi cấu hình null', async () => {
  const http = fakeHttp([], standardResponse);
  const nim = makeClient(http);
  const result = await nim.chat({ messages: [{ role: 'user', content: 'hi' }], reasoning: 'none', maxTokens: null });
  assert.equal(http.calls.length, 1);
  assert.equal('max_tokens' in http.calls[0].payload, false);
  assert.equal(http.calls[0].payload.reasoning_effort, 'none');
  assert.equal(result.content, 'Xin chào');
});

test('gửi max_tokens khi được đặt', async () => {
  const http = fakeHttp([], standardResponse);
  const nim = makeClient(http);
  await nim.chat({ messages: [{ role: 'user', content: 'hi' }], reasoning: 'none', maxTokens: 512 });
  assert.equal(http.calls[0].payload.max_tokens, 512);
});

test('reasoning auto map sang low, tools được gửi kèm', async () => {
  const http = fakeHttp([], standardResponse);
  const nim = makeClient(http);
  await nim.chat({
    messages: [{ role: 'user', content: 'hi' }],
    reasoning: 'auto',
    tools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }],
  });
  assert.equal(http.calls[0].payload.reasoning_effort, 'low');
  assert.equal(http.calls[0].payload.tool_choice, 'auto');
  assert.equal(http.calls[0].payload.tools.length, 1);
});

test('cho phép override model (fallback)', async () => {
  const http = fakeHttp([], standardResponse);
  const nim = makeClient(http);
  await nim.chat({
    messages: [{ role: 'user', content: 'hi' }],
    model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    reasoning: 'none',
  });
  assert.equal(http.calls[0].payload.model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
});

test('parse tool_calls từ response', async () => {
  const http = fakeHttp([], {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: 'call-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"giá vàng"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  });
  const nim = makeClient(http);
  const result = await nim.chat({ messages: [{ role: 'user', content: 'giá vàng?' }], reasoning: 'none' });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'web_search');
  assert.equal(result.toolCalls[0].arguments.query, 'giá vàng');
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.reasoning, '');
});

test('bỏ reasoning_content khỏi kết quả trả về', async () => {
  const http = fakeHttp([], {
    choices: [
      {
        message: { content: 'Đáp án', reasoning_content: 'suy nghĩ nội bộ' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  const nim = makeClient(http);
  const result = await nim.chat({ messages: [{ role: 'user', content: 'x' }], reasoning: 'none' });
  assert.equal(result.content, 'Đáp án');
  assert.equal(result.reasoning, 'suy nghĩ nội bộ');
});
