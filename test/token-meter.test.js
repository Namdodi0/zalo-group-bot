import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalibrator, createTokenMeter } from '../src/context/token-meter.js';

test('request sums system + tool + message and applies the calibrator', () => {
  const meter = createTokenMeter({ calibrator: { estimate: (raw) => raw * 2, observe: () => {}, ratio: () => 2 } });
  const result = meter.request({
    systemPrompt: 'abcd'.repeat(8),
    tools: [{ type: 'function', function: { name: 'x' } }],
    messages: [{ role: 'user', text: 'hello' }],
  });
  assert.ok(result.promptTokens > 0);
  assert.equal(result.promptTokens, result.systemTokens + result.toolTokens + result.messageTokens);
  assert.equal(result.contextWindow, 0);
  assert.equal(result.pressure, null);
});

test('pressure is computed from the context window', () => {
  const result = createTokenMeter({ calibrator: { estimate: (raw) => raw, observe: () => {}, ratio: () => 1 } })
    .request({ systemPrompt: 'x'.repeat(160), contextWindow: 100 });
  assert.equal(result.contextWindow, 100);
  assert.ok(result.pressure > 0);
});

test('observe adjusts the estimate ratio', () => {
  const meter = createTokenMeter();
  assert.equal(meter.ratio(), 1);
  meter.observe(100, 200);
  assert.ok(meter.ratio() > 1);
});

test('calibrator keeps its previous contract', () => {
  const calibrator = createCalibrator();
  calibrator.observe(100, 150);
  const first = calibrator.ratio();
  calibrator.observe(100, 50);
  assert.ok(calibrator.ratio() < first);
  calibrator.reset();
  assert.equal(calibrator.ratio(), 1);
});
