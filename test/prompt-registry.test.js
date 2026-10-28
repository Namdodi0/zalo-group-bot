import test from 'node:test';
import assert from 'node:assert/strict';
import { PromptVariableError, createPromptRegistry } from '../src/ai/prompt/registry.js';

test('section xếp theo order rồi tên, ghép bằng newline', () => {
  const registry = createPromptRegistry();
  registry.section({ name: 'b', order: 10, text: 'B' });
  registry.section({ name: 'a', order: 10, text: 'A' });
  registry.section({ name: 'first', order: -1, text: 'first' });
  assert.equal(registry.render(registry.assemble()), 'first\nA\nB');
});

test('section trùng tên hoặc order không hữu hạn thì throw', () => {
  const registry = createPromptRegistry();
  registry.section({ name: 'a', order: 0, text: 'x' });
  assert.throws(() => registry.section({ name: 'a', order: 1, text: 'y' }), /trùng tên/);
  assert.throws(() => registry.section({ name: 'b', order: Number.NaN, text: 'y' }), /order/);
});

test('section rỗng bị bỏ, không để lại dòng trống', () => {
  const registry = createPromptRegistry();
  registry.section({ name: 'a', order: 0, text: 'A' });
  registry.section({ name: 'b', order: 1, text: '   ' });
  registry.section({ name: 'c', order: 2, text: 'C' });
  assert.equal(registry.render(registry.assemble()), 'A\nC');
});

test('một section complete thay toàn bộ prompt', () => {
  const registry = createPromptRegistry();
  registry.section({ name: 'a', order: 0, text: 'A' });
  registry.section({ name: 'z', order: 99, text: 'ONLY', complete: true });
  assert.equal(registry.render(registry.assemble()), 'ONLY');

  registry.section({ name: 'y', order: 100, text: 'ALSO', complete: true });
  assert.throws(() => registry.assemble(), /1 prompt section complete/);
});

test('biến prompt được nội suy, thiếu giá trị thì throw', () => {
  const registry = createPromptRegistry();
  registry.variable('language', () => 'Vietnamese');
  registry.section({ name: 'a', order: 0, text: 'Answer in {{language}}.' });
  assert.equal(registry.render(registry.assemble()), 'Answer in Vietnamese.');

  const broken = createPromptRegistry();
  broken.section({ name: 'a', order: 0, text: 'Hello {{missing}}' });
  assert.throws(() => broken.render(broken.assemble()), PromptVariableError);
});

test('interpolate: false giữ nguyên cú pháp {{...}}', () => {
  const registry = createPromptRegistry();
  registry.section({ name: 'a', order: 0, text: 'literal {{missing}}', interpolate: false });
  assert.equal(registry.render(registry.assemble()), 'literal {{missing}}');
});

test('tên biến không hợp lệ hoặc trùng thì throw', () => {
  const registry = createPromptRegistry();
  assert.throws(() => registry.variable('Bad-Name', () => 'x'), /không hợp lệ/);
  registry.variable('ok', () => 'x');
  assert.throws(() => registry.variable('ok', () => 'y'), /trùng tên/);
});

test('context runtime và tool names được resolve trong assembly', () => {
  const registry = createPromptRegistry();
  registry.tools(() => ({ names: ['web_search', 'send_sticker'] }));
  registry.context({ name: 'runtime:time', order: 0, text: (ctx) => (ctx.text === 'hôm nay' ? 'now' : '') });
  registry.section({ name: 'a', order: 0, text: (ctx) => [...ctx.toolNames].sort().join(',') });

  const first = registry.assemble({ text: 'hôm nay' });
  assert.equal(registry.render(first), 'send_sticker,web_search');
  assert.deepEqual(first.contexts, [{ name: 'runtime:time', order: 0, text: 'now', interpolate: true, required: false }]);

  const second = registry.assemble({ text: 'chào' });
  assert.equal(second.contexts[0].text, '');
});

test('disposer gỡ section/context/variable', () => {
  const registry = createPromptRegistry();
  const remove = registry.section({ name: 'a', order: 0, text: 'A' });
  remove();
  assert.equal(registry.render(registry.assemble()), '');
  assert.equal(registry.has('a'), false);
});
