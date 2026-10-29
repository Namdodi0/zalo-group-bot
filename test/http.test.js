import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitOpenError, HttpError, createHttp } from '../src/http.js';

/** @param {unknown} body @param {number} [status] */
function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const noSleep = async () => {};

test('requestJson retries then succeeds', async () => {
  let calls = 0;
  const http = createHttp({
    sleep: noSleep,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return response({ error: 'boom' }, 503);
      return response({ ok: true, value: 42 });
    },
  });
  const result = await http.requestJson('https://example.com', { service: 'test', retries: 2 });
  assert.equal(calls, 3);
  assert.equal(result.data.value, 42);
});

test('requestJson does not retry on 400', async () => {
  let calls = 0;
  const http = createHttp({
    sleep: noSleep,
    fetchImpl: async () => {
      calls += 1;
      return response({ error: 'bad' }, 400);
    },
  });
  await assert.rejects(
    () => http.requestJson('https://example.com', { service: 'test', retries: 2 }),
    (error) => error instanceof HttpError && error.status === 400 && error.retryable === false,
  );
  assert.equal(calls, 1);
});

test('requestJson reports invalid JSON', async () => {
  const http = createHttp({ sleep: noSleep, fetchImpl: async () => response('not-json') });
  await assert.rejects(
    () => http.requestJson('https://example.com', { service: 'test', retries: 0 }),
    (error) => error instanceof HttpError,
  );
});

test('no retry and no breaker trip when the caller aborts', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const http = createHttp({
    sleep: noSleep,
    fetchImpl: async () => {
      calls += 1;
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  });
  for (let i = 0; i < 6; i += 1) {
    await assert.rejects(() =>
      http.requestJson('https://example.com', { service: 'abort-svc', retries: 2, signal: controller.signal }),
    );
  }
  assert.equal(calls, 6);
  assert.equal(http.stateOf('abort-svc').open, false);
});

test('circuit breaker opens after 5 server failures', async () => {
  let calls = 0;
  const http = createHttp({
    sleep: noSleep,
    fetchImpl: async () => {
      calls += 1;
      return response({ error: 'nope' }, 500);
    },
  });
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(() => http.requestJson('https://example.com', { service: 'breaker', retries: 0 }));
  }
  await assert.rejects(
    () => http.requestJson('https://example.com', { service: 'breaker', retries: 0 }),
    (error) => error instanceof CircuitOpenError,
  );
  assert.equal(calls, 5);
  assert.equal(http.stateOf('breaker').open, true);
});

test('client errors (4xx) do not trip the circuit breaker', async () => {
  let calls = 0;
  const http = createHttp({
    sleep: noSleep,
    fetchImpl: async () => {
      calls += 1;
      return response({ error: 'unauthorized' }, 401);
    },
  });
  for (let i = 0; i < 8; i += 1) {
    await assert.rejects(() => http.requestJson('https://example.com', { service: 'auth', retries: 0 }));
  }
  assert.equal(calls, 8);
  assert.equal(http.stateOf('auth').open, false);
});
