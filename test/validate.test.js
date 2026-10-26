import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageValidator } from '../src/media/validate.js';

/** @param {{status?: number, headers?: Record<string,string>, throws?: boolean}} spec */
function fakeResponse(spec = {}) {
  if (spec.throws) throw new Error('network down');
  const status = spec.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(spec.headers ?? {}),
    body: { cancel: async () => {} },
  };
}

test('chấp nhận ảnh có content-type image/*', async () => {
  const validator = createImageValidator({
    fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'image/png' } }),
  });
  const result = await validator.validate('https://example.com/a.png');
  assert.equal(result.ok, true);
});

test('từ chối content-type không phải ảnh', async () => {
  const validator = createImageValidator({
    fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'text/html' } }),
  });
  const result = await validator.validate('https://example.com/page');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /content-type/);
});

test('HEAD 403 thì fallback GET', async () => {
  const calls = [];
  const validator = createImageValidator({
    fetchImpl: async (_url, opts) => {
      calls.push(opts.method);
      if (opts.method === 'HEAD') return fakeResponse({ status: 403 });
      return fakeResponse({ status: 200, headers: { 'content-type': 'image/jpeg' } });
    },
  });
  const result = await validator.validate('https://example.com/b.jpg');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['HEAD', 'GET']);
});

test('lỗi mạng ở HEAD thì thử GET', async () => {
  let first = true;
  const validator = createImageValidator({
    fetchImpl: async () => {
      if (first) {
        first = false;
        return fakeResponse({ throws: true });
      }
      return fakeResponse({ headers: { 'content-type': 'image/webp' } });
    },
  });
  const result = await validator.validate('https://example.com/c.webp');
  assert.equal(result.ok, true);
});

test('cache kết quả theo URL', async () => {
  let calls = 0;
  const validator = createImageValidator({
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse({ headers: { 'content-type': 'image/png' } });
    },
  });
  await validator.validate('https://example.com/d.png');
  await validator.validate('https://example.com/d.png');
  assert.equal(calls, 1);
});

test('chặn ảnh quá lớn ngay cả khi HEAD trả content-length', async () => {
  const validator = createImageValidator({
    fetchImpl: async () =>
      fakeResponse({ headers: { 'content-type': 'image/png', 'content-length': String(100 * 1024 * 1024) } }),
  });
  const result = await validator.validate('https://example.com/huge.png');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /quá lớn/);
});

test('GET range dùng content-range để biết tổng dung lượng', async () => {
  const validator = createImageValidator({
    fetchImpl: async (_url, opts) => {
      if (opts.method === 'HEAD') return fakeResponse({ status: 403 });
      return fakeResponse({
        status: 206,
        headers: {
          'content-type': 'image/png',
          'content-length': '2',
          'content-range': 'bytes 0-1/52428800',
        },
      });
    },
  });
  const result = await validator.validate('https://example.com/big-range.png');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /quá lớn/);
});

test('từ chối URL không hợp lệ', async () => {
  const validator = createImageValidator({ fetchImpl: async () => fakeResponse() });
  const result = await validator.validate('ftp://example.com/a.png');
  assert.equal(result.ok, false);
});
