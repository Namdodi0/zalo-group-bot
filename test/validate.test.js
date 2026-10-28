import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageValidator, isPrivateAddress } from '../src/media/validate.js';

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

/** Hostname trong test luôn trỏ về IP công khai (tránh DNS thật). */
const publicLookup = async () => ['203.0.113.10'];

/** @param {typeof fetch} fetchImpl @param {Record<string, any>} [extra] */
function makeValidator(fetchImpl, extra = {}) {
  return createImageValidator({ fetchImpl, lookup: publicLookup, ...extra });
}

test('chấp nhận ảnh có content-type image/*', async () => {
  const validator = makeValidator(async () => fakeResponse({ headers: { 'content-type': 'image/png' } }));
  const result = await validator.validate('https://example.com/a.png');
  assert.equal(result.ok, true);
});

test('từ chối content-type không phải ảnh', async () => {
  const validator = makeValidator(async () => fakeResponse({ headers: { 'content-type': 'text/html' } }));
  const result = await validator.validate('https://example.com/page');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /content-type/);
});

test('HEAD 403 thì fallback GET', async () => {
  const calls = [];
  const validator = makeValidator(async (_url, opts) => {
    calls.push(opts.method);
    if (opts.method === 'HEAD') return fakeResponse({ status: 403 });
    return fakeResponse({ status: 200, headers: { 'content-type': 'image/jpeg' } });
  });
  const result = await validator.validate('https://example.com/b.jpg');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['HEAD', 'GET']);
});

test('lỗi mạng ở HEAD thì thử GET', async () => {
  let first = true;
  const validator = makeValidator(async () => {
    if (first) {
      first = false;
      return fakeResponse({ throws: true });
    }
    return fakeResponse({ headers: { 'content-type': 'image/webp' } });
  });
  const result = await validator.validate('https://example.com/c.webp');
  assert.equal(result.ok, true);
});

test('cache kết quả theo URL', async () => {
  let calls = 0;
  const validator = makeValidator(async () => {
    calls += 1;
    return fakeResponse({ headers: { 'content-type': 'image/png' } });
  });
  await validator.validate('https://example.com/d.png');
  await validator.validate('https://example.com/d.png');
  assert.equal(calls, 1);
});

test('chặn ảnh quá lớn ngay cả khi HEAD trả content-length', async () => {
  const validator = makeValidator(async () =>
    fakeResponse({ headers: { 'content-type': 'image/png', 'content-length': String(100 * 1024 * 1024) } }),
  );
  const result = await validator.validate('https://example.com/huge.png');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /quá lớn/);
});

test('GET range dùng content-range để biết tổng dung lượng', async () => {
  const validator = makeValidator(async (_url, opts) => {
    if (opts.method === 'HEAD') return fakeResponse({ status: 403 });
    return fakeResponse({
      status: 206,
      headers: {
        'content-type': 'image/png',
        'content-length': '2',
        'content-range': 'bytes 0-1/52428800',
      },
    });
  });
  const result = await validator.validate('https://example.com/big-range.png');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /quá lớn/);
});

test('từ chối URL không hợp lệ', async () => {
  const validator = makeValidator(async () => fakeResponse());
  const result = await validator.validate('ftp://example.com/a.png');
  assert.equal(result.ok, false);
});

test('isPrivateAddress nhận diện dải nội bộ', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '203.0.113.10', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('chặn URL trỏ thẳng vào IP nội bộ (không gọi mạng)', async () => {
  let calls = 0;
  const validator = makeValidator(async () => {
    calls += 1;
    return fakeResponse({ headers: { 'content-type': 'image/png' } });
  });
  for (const url of ['http://127.0.0.1:8787/metrics', 'http://192.168.1.5/a.png', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/a.png']) {
    const result = await validator.validate(url);
    assert.equal(result.ok, false, url);
    assert.match(String(result.reason), /nội bộ/, url);
  }
  assert.equal(calls, 0);
});

test('chặn hostname phân giải về IP nội bộ', async () => {
  const validator = createImageValidator({
    fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'image/png' } }),
    lookup: async () => ['10.0.0.5'],
  });
  const result = await validator.validate('https://internal.example/a.png');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /nội bộ/);
});

test('theo redirect thủ công và chặn redirect vào IP nội bộ', async () => {
  const targets = [];
  const validator = makeValidator(async (url) => {
    targets.push(String(url));
    return fakeResponse({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
  });
  const result = await validator.validate('https://example.com/redirect.png');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /nội bộ/);
  assert.ok(
    targets.every((url) => !url.includes('169.254.169.254')),
    'không được gọi tới đích nội bộ',
  );
});

test('theo redirect công khai tới ảnh hợp lệ', async () => {
  const targets = [];
  const validator = makeValidator(async (url) => {
    targets.push(String(url));
    if (targets.length === 1) {
      return fakeResponse({ status: 301, headers: { location: 'https://cdn.example/x.png' } });
    }
    return fakeResponse({ headers: { 'content-type': 'image/png' } });
  });
  const result = await validator.validate('https://example.com/start.png');
  assert.equal(result.ok, true);
  assert.equal(targets.length, 2);
});

test('chặn vòng redirect quá nhiều hop', async () => {
  const validator = makeValidator(async () =>
    fakeResponse({ status: 302, headers: { location: 'https://example.com/loop.png' } }),
  );
  const result = await validator.validate('https://example.com/loop.png');
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /redirect/i);
});
