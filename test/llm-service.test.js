import test from 'node:test';
import assert from 'node:assert/strict';
import { LLM_ERROR, LlmError, asLlmError } from '../src/ai/llm/errors.js';
import { createRetryExecutor } from '../src/ai/llm/retry.js';
import { createLlmService } from '../src/ai/llm/service.js';
import { CircuitOpenError, HttpError } from '../src/http.js';
import { silentLogger } from '../test-utils/helpers.js';

function makeAdapter(id, chat, overrides = {}) {
  return {
    id,
    model: `${id}-model`,
    credentialed: true,
    chat,
    async warmup() {
      return { ok: true, ms: 1, model: `${id}-model` };
    },
    ...overrides,
  };
}

test('service: a duplicate adapter route throws', () => {
  const service = createLlmService({ logger: silentLogger });
  service.register(makeAdapter('deepseek', async () => ({})));
  assert.throws(() => service.register(makeAdapter('deepseek', async () => ({}))), LlmError);
});

test('service: an unregistered provider gives NO_ADAPTER', async () => {
  const service = createLlmService({ logger: silentLogger });
  await assert.rejects(() => service.chat({ provider: 'nope', messages: [] }), (error) => {
    assert.equal(error.code, LLM_ERROR.NO_ADAPTER);
    return true;
  });
});

test('service: the request sent to the adapter is immutable and provider/model are filled in', async () => {
  let seen = null;
  const service = createLlmService({ logger: silentLogger });
  service.register(
    makeAdapter('nim', async (request) => {
      seen = request;
      assert.equal(Object.isFrozen(request), true);
      return { content: 'ok' };
    }),
  );

  const result = await service.chat({ provider: 'nim', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(result.content, 'ok');
  assert.equal(seen.provider, 'nim');
  assert.equal(seen.model, 'nim-model');
});

test('service: a missing credential gives MISSING_CREDENTIAL', async () => {
  const service = createLlmService({ logger: silentLogger });
  service.register(makeAdapter('deepseek', async () => ({ content: '' }), { credentialed: false }));
  await assert.rejects(() => service.chat({ provider: 'deepseek', messages: [] }), (error) => {
    assert.equal(error.code, LLM_ERROR.MISSING_CREDENTIAL);
    return true;
  });
});

test('service: adapter errors are normalized into LlmError', async () => {
  const service = createLlmService({ logger: silentLogger });
  service.register(
    makeAdapter('nim', async () => {
      throw new HttpError('rate limited', { status: 429 });
    }),
  );
  await assert.rejects(() => service.chat({ provider: 'nim', messages: [] }), (error) => {
    assert.equal(error.code, LLM_ERROR.RATE_LIMIT);
    assert.equal(error.retryable, true);
    return true;
  });
});

test('errors: map status/body to stable codes', () => {
  assert.equal(asLlmError(new HttpError('x', { status: 401 })).code, LLM_ERROR.AUTH);
  assert.equal(asLlmError(new HttpError('x', { status: 403 })).code, LLM_ERROR.AUTH);
  assert.equal(asLlmError(new HttpError('x', { status: 408 })).code, LLM_ERROR.TIMEOUT);
  assert.equal(asLlmError(new HttpError('x', { status: 503 })).code, LLM_ERROR.PROVIDER_ERROR);
  assert.equal(asLlmError(new HttpError('x', { status: 400 })).code, LLM_ERROR.BAD_REQUEST);
  assert.equal(asLlmError(new HttpError('x', { status: 0 })).code, LLM_ERROR.TIMEOUT);

  const overflow = asLlmError(
    new HttpError('bad request', { status: 400, body: '{"error":"maximum context length exceeded"}' }),
  );
  assert.equal(overflow.code, LLM_ERROR.CONTEXT_WINDOW_EXCEEDED);

  const circuit = asLlmError(new CircuitOpenError('nim', 1000));
  assert.equal(circuit.code, LLM_ERROR.PROVIDER_ERROR);
  assert.equal(circuit.retryable, false);

  const abort = asLlmError(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  assert.equal(abort.code, LLM_ERROR.ABORTED);
});

test('retry: retries a retryable error then returns the result', async () => {
  let attempts = 0;
  const executor = createRetryExecutor({
    sleep: async () => {},
    shouldRetry: (error) => error instanceof LlmError && error.retryable,
  });
  const result = await executor.execute(async () => {
    attempts += 1;
    if (attempts < 2) throw new LlmError(LLM_ERROR.TIMEOUT, 'timeout', { retryable: true });
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
});

test('retry: does not retry a non-retryable error and keeps the last error', async () => {
  let attempts = 0;
  const executor = createRetryExecutor({ sleep: async () => {}, shouldRetry: (error) => error.retryable });
  await assert.rejects(
    () =>
      executor.execute(async () => {
        attempts += 1;
        throw new LlmError(LLM_ERROR.AUTH, 'bad key', { retryable: false });
      }),
    (error) => error.code === LLM_ERROR.AUTH,
  );
  assert.equal(attempts, 1);
});

test('retry: stops when the deadline runs out', async () => {
  let attempts = 0;
  const executor = createRetryExecutor({ sleep: async () => {}, shouldRetry: () => true, minRemainingMs: 1000 });
  await assert.rejects(
    () =>
      executor.execute(
        async () => {
          attempts += 1;
          throw new LlmError(LLM_ERROR.TIMEOUT, 'timeout', { retryable: true });
        },
        { deadline: Date.now() + 10 },
      ),
    /Timed out/,
  );
  assert.equal(attempts, 0);
});
