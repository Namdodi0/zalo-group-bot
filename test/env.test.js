import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describeEnvHints, loadEnvFiles, parseEnvFile } from '../src/env.js';
import { loadConfig } from '../src/config.js';

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-env-'));
}

test('parseEnvFile: key=value, comment, dòng trắng, tiền tố export', () => {
  const entries = parseEnvFile(
    ['# comment', '', 'ZALO_BOT_TOKEN=123:abc', 'export NIM_API_KEY=nvapi-x', 'SPACED = 1 '].join('\n'),
  );
  assert.deepEqual(entries, [
    ['ZALO_BOT_TOKEN', '123:abc'],
    ['NIM_API_KEY', 'nvapi-x'],
    ['SPACED', '1'],
  ]);
});

test('parseEnvFile: bỏ BOM + CRLF (file do panel/Notepad ghi)', () => {
  const text = '\uFEFFZALO_BOT_TOKEN=123:abc\r\nNIM_API_KEY=nvapi-x\r\n';
  assert.deepEqual(parseEnvFile(text), [
    ['ZALO_BOT_TOKEN', '123:abc'],
    ['NIM_API_KEY', 'nvapi-x'],
  ]);
});

test('parseEnvFile: quote đơn/kép và comment cuối dòng', () => {
  assert.deepEqual(parseEnvFile('A="có # không phải comment"'), [['A', 'có # không phải comment']]);
  assert.deepEqual(parseEnvFile("B='giữ nguyên $VAR'"), [['B', 'giữ nguyên $VAR']]);
  assert.deepEqual(parseEnvFile('C=abc  # chú thích'), [['C', 'abc']]);
  assert.deepEqual(parseEnvFile('D="a\\nb"'), [['D', 'a\nb']]);
});

test('parseEnvFile: bỏ qua dòng rác và key không hợp lệ', () => {
  const entries = parseEnvFile(['không-có-dấu-bằng', '=no-key', '1BAD=x', 'GOOD=1', '# A=1'].join('\n'));
  assert.deepEqual(entries, [['GOOD', '1']]);
});

test('loadEnvFiles: nạp .env, biến có sẵn trong môi trường thắng file', async () => {
  const dir = await tempDir();
  await fsp.writeFile(path.join(dir, '.env'), 'ZALO_BOT_TOKEN=from-file\nNIM_API_KEY=nvapi-file\n');
  const env = { NIM_API_KEY: 'nvapi-panel' };
  const report = loadEnvFiles({ cwd: dir, env });

  assert.equal(env.ZALO_BOT_TOKEN, 'from-file');
  assert.equal(env.NIM_API_KEY, 'nvapi-panel');
  assert.equal(report.applied.includes('ZALO_BOT_TOKEN'), true);
  assert.equal(report.applied.includes('NIM_API_KEY'), false);
  assert.deepEqual(report.missing, ['.env.local']);
});

test('loadEnvFiles: biến rỗng sẵn có được phép điền từ file', async () => {
  const dir = await tempDir();
  await fsp.writeFile(path.join(dir, '.env'), 'ZALO_BOT_TOKEN=from-file\n');
  const env = { ZALO_BOT_TOKEN: '' };
  loadEnvFiles({ cwd: dir, env });
  assert.equal(env.ZALO_BOT_TOKEN, 'from-file');
});

test('loadEnvFiles: không có .env thì không ném lỗi, report ghi missing', async () => {
  const dir = await tempDir();
  const env = {};
  const report = loadEnvFiles({ cwd: dir, env });
  assert.deepEqual(env, {});
  assert.deepEqual(report.missing, ['.env', '.env.local']);
  assert.equal(report.files.every((file) => file.found === false), true);
});

test('loadConfig đọc được token từ .env mà không cần cờ --env-file-if-exists', async () => {
  const dir = await tempDir();
  await fsp.writeFile(
    path.join(dir, '.env'),
    [
      'ZALO_BOT_TOKEN=123:abc',
      'NIM_API_KEY=nvapi-test',
      'TAVILY_API_KEY=tvly-test',
      'MODEL_DEFAULT=nim',
      'MODEL_FALLBACK=nim-light',
    ].join('\n'),
  );
  /** @type {Record<string, string>} */
  const env = {};
  loadEnvFiles({ cwd: dir, env });
  const config = loadConfig({ argv: [], env, cwd: dir });
  assert.equal(config.zalo.token, '123:abc');
  assert.equal(config.model.defaultAlias, 'nim');
});

test('describeEnvHints: chỉ ra thư mục và file thiếu khi chưa có .env', async () => {
  const dir = await tempDir();
  loadEnvFiles({ cwd: dir, env: {} });
  const hints = describeEnvHints();
  assert.equal(hints.some((line) => line.includes(dir)), true);
  assert.equal(hints.some((line) => line.includes('.env: không tìm thấy')), true);
  assert.equal(hints.some((line) => line.includes('tạo file .env')), true);
});

test('describeEnvHints: báo đã nạp bao nhiêu biến khi có .env', async () => {
  const dir = await tempDir();
  await fsp.writeFile(path.join(dir, '.env'), 'A=1\nB=2\n');
  loadEnvFiles({ cwd: dir, env: {} });
  const hints = describeEnvHints();
  assert.equal(hints.some((line) => line.includes('.env: có (2 biến nạp từ file)')), true);
});
