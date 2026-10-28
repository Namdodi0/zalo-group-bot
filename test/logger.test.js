import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, printBanner, visualWidth } from '../src/logger.js';

function sink() {
  /** @type {string[]} */
  const lines = [];
  return { lines, stream: { write: (line) => lines.push(line) } };
}

function jsonLogger(extra = {}) {
  const out = sink();
  const err = sink();
  const logger = createLogger({
    level: 'info',
    format: 'json',
    secrets: ['super-secret-value'],
    stdout: /** @type {any} */ (out.stream),
    stderr: /** @type {any} */ (err.stream),
    ...extra,
  });
  return { logger, out, err };
}

test('JSON: redacts secrets but keeps non-sensitive keys', () => {
  const { logger, out, err } = jsonLogger();
  logger.info('cfg', {
    token: 'abc',
    nimKey: 'def',
    maxTokens: 'unlimited',
    promptTokens: 10,
    note: 'super-secret-value',
    raw: 'nvapi-abcdefghijklmnopqrstuvwxyz',
  });
  const payload = JSON.parse(out.lines[0]);
  assert.equal(payload.token, '***');
  assert.equal(payload.nimKey, '***');
  assert.equal(payload.maxTokens, 'unlimited');
  assert.equal(payload.promptTokens, 10);
  assert.equal(payload.note, '***');
  assert.equal(payload.raw, '***');
  assert.equal(err.lines.length, 0);
});

test('JSON: warn/error go to stderr, debug is filtered', () => {
  const { logger, out, err } = jsonLogger();
  logger.debug('hidden');
  logger.warn('warning');
  logger.error('error');
  assert.equal(out.lines.length, 0);
  assert.equal(err.lines.length, 2);
});

test('pretty: one compact line with time, icon, message, fields', () => {
  const out = sink();
  const logger = createLogger({
    level: 'info',
    format: 'pretty',
    color: 'never',
    stdout: /** @type {any} */ (out.stream),
    now: () => new Date(2026, 9, 26, 18, 31, 2),
  });
  logger.info('zalo bot ready', { id: '2214705736200876533', name: 'Bot deepseek', icon: '🤖' });
  const line = out.lines[0].trimEnd();
  assert.match(line, /^18:31:02 🤖 zalo bot ready\s+id=2214705736200876533 name="Bot deepseek"$/);
  assert.equal(line.includes('\u001b['), false);
});

test('pretty: default icon per level, colored when enabled', () => {
  const out = sink();
  const logger = createLogger({
    level: 'debug',
    format: 'pretty',
    color: 'always',
    stdout: /** @type {any} */ (out.stream),
    stderr: /** @type {any} */ (out.stream),
  });
  logger.info('no icon');
  logger.warn('warning');
  logger.error('error');
  assert.match(out.lines[0], /ℹ/);
  assert.match(out.lines[1], /▲/);
  assert.match(out.lines[2], /✖/);
  for (const line of out.lines) assert.ok(line.includes('\u001b['));
});

test('pretty: still redacts and formats errors compactly', () => {
  const out = sink();
  const logger = createLogger({
    level: 'info',
    format: 'pretty',
    color: 'never',
    secrets: ['super-secret-password'],
    stdout: /** @type {any} */ (out.stream),
    stderr: /** @type {any} */ (out.stream),
  });
  logger.error('send failed', { token: 'super-secret-password', error: new Error('connection lost') });
  const line = out.lines[0];
  assert.equal(line.includes('super-secret-password'), false);
  assert.match(line, /token=\*\*\*/);
  assert.match(line, /connection lost/);
  assert.equal(line.includes('\n'), true); // trailing newline
});

test('pretty: long values are truncated, objects compacted to JSON', () => {
  const out = sink();
  const logger = createLogger({
    level: 'info',
    format: 'pretty',
    color: 'never',
    stdout: /** @type {any} */ (out.stream),
  });
  logger.info('x', { long: 'a'.repeat(200), obj: { a: 1 } });
  const line = out.lines[0];
  assert.ok(line.includes('…'), 'must contain an ellipsis');
  assert.match(line, /obj=\{"a":1\}/);
});

test('banner stays aligned even with emoji', () => {
  const out = sink();
  printBanner(out.stream, ['🤖 Bot deepseek', 'nvidia/nemotron-3.5-super-vl-120b-a12b'], { color: 'never' });
  const lines = out.lines.join('').trimEnd().split('\n');
  assert.equal(lines.length, 4);
  const widths = lines.map((line) => visualWidth(line));
  assert.equal(new Set(widths).size, 1, `misaligned columns: ${widths.join(',')}`);
  assert.match(lines[0], /^╭─+╮$/);
  assert.match(lines[3], /^╰─+╯$/);
});

test('visualWidth counts emoji as 2 columns', () => {
  assert.equal(visualWidth('abc'), 3);
  assert.equal(visualWidth('🤖'), 2);
  assert.equal(visualWidth('a🤖b'), 4);
});
