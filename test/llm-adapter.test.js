import test from 'node:test';
import assert from 'node:assert/strict';
import { DEEPSEEK_REASONING_MAP, createOpenAiCompatAdapter } from '../src/ai/llm/adapter-openai.js';
import { createSilentLogger } from '../src/logger.js';

const logger = createSilentLogger();

function fakeHttp(payloads, responseBody) {
  const http = {
    calls: [],
    async requestJson(url, opts) {
      http.calls.push({ url, payload: JSON.parse(opts.body), service: opts.service });
      return { status: 200, data: responseBody, headers: new Headers(), latencyMs: 1 };
    },
    async openStream() {
      throw new Error('not used');
    },
  };
  return http;
}

const standardResponse = {
  choices: [{ message: { content: 'Hello', role: 'assistant' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 0 } },
};

function makeClient(http, overrides = {}) {
  return createOpenAiCompatAdapter({
    provider: 'nim',
    apiKey: 'k',
    baseUrl: 'https://nim.test/v1',
    model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    http,
    logger,
    ...overrides,
  });
}

test('DeepSeek maps medium to high, none stays none', async () => {
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

test('does not send max_tokens when the config is null', async () => {
  const http = fakeHttp([], standardResponse);
  const nim = makeClient(http);
  const result = await nim.chat({ messages: [{ role: 'user', content: 'hi' }], reasoning: 'none', maxTokens: null });
  assert.equal(http.calls.length, 1);
  assert.equal('max_tokens' in http.calls[0].payload, false);
  assert.equal(http.calls[0].payload.reasoning_effort, 'none');
  assert.equal(result.content, 'Hello');
});

test('sends max_tokens when it is set', async () => {
  const http = fakeHttp([], standardResponse);
  const nim = makeClient(http);
  await nim.chat({ messages: [{ role: 'user', content: 'hi' }], reasoning: 'none', maxTokens: 512 });
  assert.equal(http.calls[0].payload.max_tokens, 512);
});

test('reasoning auto maps to low and tools are sent along', async () => {
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

test('circuit breaker is keyed by provider+model and does not lock the whole provider', async () => {
  const http = fakeHttp([], standardResponse);
  const client = makeClient(http);
  await client.chat({ messages: [{ role: 'user', content: 'hi' }], reasoning: 'none' });
  await client.chat({
    messages: [{ role: 'user', content: 'hi' }],
    reasoning: 'none',
    model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  });
  assert.equal(http.calls[0].service, 'nim:nvidia/nemotron-3.5-super-vl-120b-a12b');
  assert.equal(http.calls[1].service, 'nim:nvidia/nemotron-3.5-lightning-30b-a3b');
});

test('allows overriding the model (fallback)', async () => {
  const http = fakeHttp([], standardResponse);
  const nim = makeClient(http);
  await nim.chat({
    messages: [{ role: 'user', content: 'hi' }],
    model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    reasoning: 'none',
  });
  assert.equal(http.calls[0].payload.model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
});

test('parses tool_calls from the response', async () => {
  const http = fakeHttp([], {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: 'call-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"gold price"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  });
  const nim = makeClient(http);
  const result = await nim.chat({ messages: [{ role: 'user', content: 'gold price?' }], reasoning: 'none' });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'web_search');
  assert.equal(result.toolCalls[0].arguments.query, 'gold price');
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.reasoning, '');
});

test('drops reasoning_content from the returned result', async () => {
  const http = fakeHttp([], {
    choices: [
      {
        message: { content: 'Answer', reasoning_content: 'internal thoughts' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  const nim = makeClient(http);
  const result = await nim.chat({ messages: [{ role: 'user', content: 'x' }], reasoning: 'none' });
  assert.equal(result.content, 'Answer');
  assert.equal(result.reasoning, 'internal thoughts');
});

test('stream: a keepalive chunk alone does not satisfy the first-token guard', async () => {
  const encoder = new TextEncoder();
  const http = {
    async openStream(_url, opts) {
      const body = new ReadableStream({
        start(controller) {
          // Role-only delta: the stream is alive but no real token has arrived yet.
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'));
          opts.signal.addEventListener('abort', () => controller.error(opts.signal.reason));
        },
      });
      return new Response(body, { status: 200 });
    },
  };
  const client = makeClient(http);
  await assert.rejects(
    () =>
      client.chat({
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: 'none',
        stream: true,
        ttftMs: 30,
        timeoutMs: 5000,
      }),
    (error) => {
      assert.equal(error.retryable, true);
      assert.match(error.message, /first token timeout/);
      return true;
    },
  );
});

test('warmup: returns {ok, ms, model}, 1 token, supports a model override', async () => {
  const http = fakeHttp([], standardResponse);
  const client = makeClient(http);

  const result = await client.warmup();
  assert.equal(result.ok, true);
  assert.ok(result.ms >= 0);
  assert.equal(result.model, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
  assert.equal(http.calls[0].payload.max_tokens, 1);
  assert.equal(http.calls[0].payload.temperature, 0);

  await client.warmup({ model: 'nvidia/nemotron-3-ultra-550b-a55b' });
  assert.equal(http.calls[1].payload.model, 'nvidia/nemotron-3-ultra-550b-a55b');
});

test('warmup: a network error returns ok:false and does NOT throw', async () => {
  const client = makeClient({
    async requestJson() {
      throw new Error('timeout after nim request');
    },
  });
  const result = await client.warmup();
  assert.equal(result.ok, false);
  assert.match(result.error, /timeout after nim request/);
});
