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

test('parseEnvFile: key=value, comments, blank lines, export prefix', () => {
  const entries = parseEnvFile(
    ['# comment', '', 'ZALO_BOT_TOKEN=123:abc', 'export NIM_API_KEY=nvapi-x', 'SPACED = 1 '].join('\n'),
  );
  assert.deepEqual(entries, [
    ['ZALO_BOT_TOKEN', '123:abc'],
    ['NIM_API_KEY', 'nvapi-x'],
    ['SPACED', '1'],
  ]);
});

test('parseEnvFile: strips BOM + CRLF (files written by panels/Notepad)', () => {
  const text = '\uFEFFZALO_BOT_TOKEN=123:abc\r\nNIM_API_KEY=nvapi-x\r\n';
  assert.deepEqual(parseEnvFile(text), [
    ['ZALO_BOT_TOKEN', '123:abc'],
    ['NIM_API_KEY', 'nvapi-x'],
  ]);
});

test('parseEnvFile: single/double quotes and trailing comments', () => {
  assert.deepEqual(parseEnvFile('A="has # not a comment"'), [['A', 'has # not a comment']]);
  assert.deepEqual(parseEnvFile("B='keep $VAR as is'"), [['B', 'keep $VAR as is']]);
  assert.deepEqual(parseEnvFile('C=abc  # note'), [['C', 'abc']]);
  assert.deepEqual(parseEnvFile('D="a\\nb"'), [['D', 'a\nb']]);
});

test('parseEnvFile: skips junk lines and invalid keys', () => {
  const entries = parseEnvFile(['no-equals-sign', '=no-key', '1BAD=x', 'GOOD=1', '# A=1'].join('\n'));
  assert.deepEqual(entries, [['GOOD', '1']]);
});

test('loadEnvFiles: loads .env, variables already in the environment win over the file', async () => {
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

test('loadEnvFiles: an existing empty variable may be filled from the file', async () => {
  const dir = await tempDir();
  await fsp.writeFile(path.join(dir, '.env'), 'ZALO_BOT_TOKEN=from-file\n');
  const env = { ZALO_BOT_TOKEN: '' };
  loadEnvFiles({ cwd: dir, env });
  assert.equal(env.ZALO_BOT_TOKEN, 'from-file');
});

test('loadEnvFiles: no .env does not throw, the report records it as missing', async () => {
  const dir = await tempDir();
  const env = {};
  const report = loadEnvFiles({ cwd: dir, env });
  assert.deepEqual(env, {});
  assert.deepEqual(report.missing, ['.env', '.env.local']);
  assert.equal(report.files.every((file) => file.found === false), true);
});

test('loadConfig reads API keys from .env without the --env-file-if-exists flag', async () => {
  const dir = await tempDir();
  await fsp.writeFile(
    path.join(dir, '.env'),
    [
      'ZALO_BOT_TOKEN=123:abc',
      'NIM_API_KEY=nvapi-test',
      'DEEPSEEK_API_KEY=sk-test',
      'TAVILY_API_KEY=tvly-test',
    ].join('\n'),
  );
  /** @type {Record<string, string>} */
  const env = {};
  loadEnvFiles({ cwd: dir, env });
  const config = loadConfig({ argv: [], env, cwd: dir, config: {} });
  assert.equal(config.zalo.token, '123:abc');
  assert.equal(config.nim.apiKey, 'nvapi-test');
  assert.equal(config.deepseek.apiKey, 'sk-test');
  assert.equal(config.search.apiKey, 'tvly-test');
});

test('describeEnvHints: points out the directory and missing files when there is no .env', async () => {
  const dir = await tempDir();
  loadEnvFiles({ cwd: dir, env: {} });
  const hints = describeEnvHints();
  assert.equal(hints.some((line) => line.includes(dir)), true);
  assert.equal(hints.some((line) => line.includes('.env: not found')), true);
  assert.equal(hints.some((line) => line.includes('create a .env file')), true);
});

test('describeEnvHints: reports how many variables were loaded when .env exists', async () => {
  const dir = await tempDir();
  await fsp.writeFile(path.join(dir, '.env'), 'A=1\nB=2\n');
  loadEnvFiles({ cwd: dir, env: {} });
  const hints = describeEnvHints();
  assert.equal(hints.some((line) => line.includes('.env: found (2 variables loaded from file)')), true);
});

test('loadEnvFiles: falls back to extraRoots when the cwd has no .env', async () => {
  const cwd = await tempDir();
  const root = await tempDir();
  await fsp.writeFile(path.join(root, '.env'), 'ZALO_BOT_TOKEN=from-root\n');
  const env = {};
  const report = loadEnvFiles({ cwd, env, extraRoots: [root], files: ['.env'] });
  assert.equal(env.ZALO_BOT_TOKEN, 'from-root');
  assert.equal(report.files[0].path, path.join(root, '.env'));
  assert.deepEqual(report.missing, []);
});
