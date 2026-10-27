import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt } from '../src/ai/prompt.js';
import { createCommands } from '../src/commands/index.js';
import { loadConfig } from '../src/config.js';
import { createMetrics } from '../src/metrics.js';
import { makeConfig, silentLogger } from '../test-utils/helpers.js';

const baseEnv = {
  ZALO_BOT_TOKEN: 'dummy-token',
  SEARCH_ENABLED: 'off',
  NIM_API_KEY: 'dummy-nim-key',
  DEEPSEEK_API_KEY: 'dummy-deepseek-key',
  MODEL_DEFAULT: 'nim',
  MODEL_FALLBACK: 'nim-light',
};

test('tone friendly: dặn không chửi và không bắt chước lịch sử thô tục', () => {
  const prompt = buildSystemPrompt({ botName: 'Bot', chatType: 'GROUP' });
  assert.match(prompt, /Do not swear/);
  assert.match(prompt, /do NOT imitate them/);
  assert.equal(prompt.includes('banter mode'), false);
});

test('tone roast: có mục TONE riêng, không còn giới hạn cứng', () => {
  const prompt = buildSystemPrompt({ botName: 'Bot', chatType: 'GROUP', tone: 'roast' });
  assert.match(prompt, /TONE OF THIS CHAT/);
  assert.match(prompt, /banter mode/);
  assert.equal(prompt.includes('HARD LIMITS'), false);
  assert.match(prompt, /Never invent sources/);
});

test('tone roast-hard: mạnh nhưng KHÔNG có câu mẫu để copy', () => {
  const prompt = buildSystemPrompt({ botName: 'Bot', chatType: 'GROUP', tone: 'roast-hard' });
  assert.match(prompt, /hard banter/);
  assert.match(prompt, /Intensity target/);
  assert.match(prompt, /Vary your wording every single turn/);
  assert.equal(prompt.includes('HARD LIMITS'), false);
  // không được chứa câu chửi cụ thể nào để model bám theo
  assert.equal(prompt.includes('thằng ngu'), false);
  assert.equal(prompt.includes('óc chó'), false);
});

test('tone lạ thì bỏ qua, không vỡ prompt', () => {
  const prompt = buildSystemPrompt({ botName: 'Bot', tone: 'khong-ton-tai' });
  assert.match(prompt, /MANDATORY RULES/);
  assert.equal(prompt.includes('HARD LIMITS'), false);
});

test('tone roast-extreme: mạnh nhất, không còn giới hạn cứng', () => {
  const prompt = buildSystemPrompt({ botName: 'Bot', chatType: 'GROUP', tone: 'roast-extreme' });
  assert.match(prompt, /TONE \(maximum\)/);
  assert.equal(prompt.includes('HARD LIMITS'), false);
  assert.equal(prompt.includes('thằng ngu'), false);
});

test('tone hard/extreme: thô tục, mất dạy', () => {
  const hard = buildSystemPrompt({ botName: 'Bot', chatType: 'GROUP', tone: 'roast-hard' });
  assert.match(hard, /REGISTER: vulgar and deliberately ill-mannered/);
  assert.match(hard, /Swear in most sentences/);
  assert.match(hard, /No manners/);
  assert.match(hard, /every turn, whether they ask for it or not/);

  const extreme = buildSystemPrompt({ botName: 'Bot', chatType: 'GROUP', tone: 'roast-extreme' });
  assert.match(extreme, /REGISTER: maximum profanity, zero manners/);
  assert.match(extreme, /Every sentence carries heavy swearing/);
});

test('tone friendly/roast không bị đẩy sang thô tục, mất dạy', () => {
  const friendly = buildSystemPrompt({ botName: 'Bot', chatType: 'GROUP' });
  assert.equal(friendly.includes('REGISTER:'), false);
  const roast = buildSystemPrompt({ botName: 'Bot', chatType: 'GROUP', tone: 'roast' });
  assert.equal(roast.includes('REGISTER:'), false);
});

test('BOT_TONE đọc từ env, có alias, mặc định là hard', () => {
  assert.equal(loadConfig({ argv: [], env: { ...baseEnv, BOT_TONE: 'roast' } }).tone, 'roast');
  assert.equal(loadConfig({ argv: [], env: { ...baseEnv, BOT_TONE: 'roast-hard' } }).tone, 'roast-hard');
  assert.equal(loadConfig({ argv: [], env: { ...baseEnv, BOT_TONE: 'hard' } }).tone, 'roast-hard');
  assert.equal(loadConfig({ argv: [], env: { ...baseEnv, BOT_TONE: 'extreme' } }).tone, 'roast-extreme');
  assert.equal(loadConfig({ argv: [], env: { ...baseEnv, BOT_TONE: 'cuc' } }).tone, 'roast-extreme');
  assert.equal(loadConfig({ argv: [], env: { ...baseEnv, BOT_TONE: 'cay' } }).tone, 'roast');
  assert.equal(loadConfig({ argv: [], env: { ...baseEnv } }).tone, 'roast-hard');
  assert.throws(() => loadConfig({ argv: [], env: { ...baseEnv, BOT_TONE: 'lung-tung' } }), /BOT_TONE/);
});

function toneCommands(overrides = {}) {
  const config = makeConfig(overrides);
  const commands = createCommands({
    config,
    store: { touch: () => {}, reset: async () => {} },
    metrics: createMetrics(),
    zalo: {},
    http: {},
    models: { resolve: () => ({}), find: () => null, list: () => [] },
    stickers: null,
    logger: silentLogger,
  });
  return { commands, config };
}

function ctx(meta = { thinking: null }) {
  return { chatId: 'chat-1', chatType: 'GROUP', senderId: 'user-1', senderName: 'Nam', record: { meta, messages: [] } };
}

test('/tone roast và /tone hard lưu vào meta + chèn mốc chuyển giọng', async () => {
  const { commands } = toneCommands();
  const c = ctx();
  const roast = await commands.run({ name: 'tone', args: 'roast' }, c);
  assert.match(roast.text, /cà khịa/);
  assert.equal(c.record.meta.tone, 'roast');

  const hard = await commands.run({ name: 'tone', args: 'hard' }, c);
  assert.match(hard.text, /nặng/);
  assert.equal(c.record.meta.tone, 'roast-hard');
  assert.equal(c.record.messages.length, 2);
});

test('/tone friendly và /tone default quay lại bình thường', async () => {
  const { commands } = toneCommands();
  const c = ctx({ thinking: null, tone: 'roast-hard' });
  const friendly = await commands.run({ name: 'tone', args: 'friendly' }, c);
  assert.match(friendly.text, /lịch sự/);
  assert.equal(c.record.meta.tone, 'friendly');
  const back = await commands.run({ name: 'tone', args: 'default' }, c);
  assert.match(back.text, /theo cấu hình/);
  assert.equal(c.record.meta.tone, null);
});

test('/tone không tham số thì hiện trạng thái, giá trị lạ thì báo lỗi', async () => {
  const { commands } = toneCommands({ tone: 'roast' });
  const c = ctx();
  const show = await commands.run({ name: 'tone', args: '' }, c);
  assert.match(show.text, /roast/);
  const bad = await commands.run({ name: 'tone', args: 'lung-tung' }, c);
  assert.match(bad.text, /không hợp lệ/);
  assert.equal(c.record.meta.tone, undefined);
});
