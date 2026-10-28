import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VERSION, readVersion, __test__ as versionTest } from '../src/version.js';
import { createLogger } from '../src/logger.js';
import { createMetrics } from '../src/metrics.js';
import { __test__ as nimTest } from '../src/ai/llm/adapter-openai.js';
import { loadConfig } from '../src/config.js';

const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));

function sink() {
  /** @type {string[]} */
  const lines = [];
  return { lines, stream: { write: (line) => lines.push(line) } };
}

test('VERSION khớp package.json', () => {
  assert.equal(VERSION, pkg.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test('readVersion trả 0.0.0 khi không đọc được package.json', () => {
  versionTest.reset();
  assert.equal(readVersion(new URL('file:///khong-ton-tai/package.json')), '0.0.0');
});

test('loadConfig có version để log', () => {
  const config = loadConfig({
    argv: [],
    env: {
      ZALO_BOT_TOKEN: '123:abc',
      NIM_API_KEY: 'nvapi-test',
      TAVILY_API_KEY: 'tvly-test',
      MODEL_DEFAULT: 'nim',
      MODEL_FALLBACK: 'nim-light',
    },
    cwd: process.cwd(),
  });
  assert.equal(config.version, VERSION);
});

test('logger JSON gắn version vào mọi dòng log', () => {
  const out = sink();
  const logger = createLogger({
    level: 'info',
    format: 'json',
    version: '9.9.9',
    stdout: /** @type {any} */ (out.stream),
    stderr: /** @type {any} */ (out.stream),
  });
  logger.info('hello', { a: 1 });
  logger.warn('cảnh báo');
  const records = out.lines.map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].version, '9.9.9');
  assert.equal(records[1].version, '9.9.9');
});

test('logger pretty cũng hiện version', () => {
  const out = sink();
  const logger = createLogger({
    level: 'info',
    format: 'pretty',
    version: '1.2.3',
    color: 'never',
    stdout: /** @type {any} */ (out.stream),
    stderr: /** @type {any} */ (out.stream),
  });
  logger.info('replied', { ms: 1234 });
  assert.match(out.lines.join('\n'), /version=1\.2\.3/);
});

test('logger không tự thêm version khi không truyền', () => {
  const out = sink();
  const logger = createLogger({
    level: 'info',
    format: 'json',
    stdout: /** @type {any} */ (out.stream),
    stderr: /** @type {any} */ (out.stream),
  });
  logger.info('x');
  assert.equal(JSON.parse(out.lines[0]).version, undefined);
});

test('metrics.gauge lưu giá trị tức thời, snapshot có gauges', () => {
  const metrics = createMetrics();
  metrics.gauge('llm.tokensPerSec', 42.7);
  metrics.gauge('llm.tokensPerSec', 51.2);
  metrics.gauge('khong-hop-le', Number.NaN);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.gauges['llm.tokensPerSec'], 51.2);
  assert.equal(snapshot.gauges['khong-hop-le'], undefined);
});

test('tokensPerSec: token/giây, làm tròn 1 chữ số, chặn số vô nghĩa', () => {
  assert.equal(nimTest.tokensPerSec(100, 2000), 50);
  assert.equal(nimTest.tokensPerSec(150, 3600), 41.7);
  assert.equal(nimTest.tokensPerSec(0, 1000), 0);
  assert.equal(nimTest.tokensPerSec(100, 0), 0);
  assert.equal(nimTest.tokensPerSec(Number.NaN, 1000), 0);
});
