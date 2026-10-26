import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLengthHint, buildSearchContext, buildSystemPrompt, SUMMARY_SYSTEM_PROMPT } from '../src/ai/prompt.js';

function groupPrompt(overrides = {}) {
  return buildSystemPrompt({
    botName: 'Bot deepseek',
    chatType: 'GROUP',
    emoji: true,
    searchEnabled: true,
    imageEnabled: true,
    stickerEnabled: true,
    ...overrides,
  });
}

test('prompt viết tiếng Anh nhưng buộc trả lời tiếng Việt', () => {
  const prompt = groupPrompt();
  assert.match(prompt, /You are "Bot deepseek"/);
  assert.match(prompt, /Default to Vietnamese/);
  assert.match(prompt, /MANDATORY RULES/);
});

test('có luật làm theo yêu cầu người dùng', () => {
  const prompt = groupPrompt();
  assert.match(prompt, /user's explicit request wins/);
  assert.match(prompt, /lawful, safe and not fabricated/);
});

test('có chính sách độ dài rõ ràng (không phải càng ngắn càng tốt)', () => {
  const prompt = groupPrompt();
  assert.equal(/at most \d+ characters/.test(prompt), false);
  assert.equal(prompt.includes('3 paragraphs'), false);
  assert.match(prompt, /no preamble/);
  assert.match(prompt, /LENGTH: default to 2–5 sentences/);
  assert.match(prompt, /never cut a useful answer short/);
  assert.match(prompt, /specific length/);
});

test('mọi tone đều có sàn độ dài: không trả lời 1 câu', () => {
  assert.match(groupPrompt({ tone: 'roast' }), /at least 2–4 sentences/);
  assert.match(groupPrompt({ tone: 'roast-hard' }), /at least 3 sentences/);
  assert.match(groupPrompt({ tone: 'roast-extreme' }), /at least 3 sentences/);
});

test('system prompt tĩnh: không chứa giờ/ngày', () => {
  const prompt = groupPrompt();
  assert.equal(prompt.includes('Thời gian hiện tại'), false);
  assert.equal(prompt, groupPrompt());
});

test('prompt thay đổi theo chat type và công cụ bật/tắt', () => {
  assert.match(groupPrompt({ chatType: 'PRIVATE' }), /a private chat/);
  assert.match(groupPrompt(), /a group chat/);

  assert.equal(groupPrompt({ searchEnabled: false }).includes('web_search'), false);
  assert.equal(groupPrompt({ imageEnabled: false }).includes('send_image'), false);
  assert.match(groupPrompt({ emoji: false }), /Never use emoji/);
});

test('prompt chứa tên bot nhận từ getMe', () => {
  assert.match(groupPrompt({ botName: 'Bot deepseek' }), /"Bot deepseek"/);
});

test('luật send_sticker bật/tắt theo cấu hình', () => {
  assert.match(groupPrompt(), /send_sticker/);
  assert.equal(groupPrompt({ stickerEnabled: false }).includes('send_sticker'), false);
});

test('prompt không có bảng markdown, dặn dán URL trần', () => {
  assert.match(groupPrompt(), /No markdown tables/);
  assert.match(groupPrompt(), /paste bare URLs/i);
});

test('search context và summary prompt vẫn ổn', () => {
  const context = buildSearchContext('giá vàng', '1. Kết quả\n   https://x');
  assert.match(context, /giá vàng/);
  assert.match(context, /cite the source URLs/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /in Vietnamese/);
});

test('buildLengthHint: câu hỏi cần giải thích thì đòi 8–12 câu', () => {
  assert.match(buildLengthHint('giải thích cách TCP hoạt động'), /8–12 câu/);
  assert.match(buildLengthHint('tại sao trời xanh?'), /8–12 câu/);
  assert.match(buildLengthHint('một câu hỏi rất dài '.repeat(5)), /8–12 câu/);
});

test('buildLengthHint: câu cụt trong group vẫn phải 3–5 câu', () => {
  assert.match(buildLengthHint('alo', { tone: 'roast-hard' }), /3–5 câu/);
  assert.match(buildLengthHint('bot đâu', { tone: 'roast' }), /3–5 câu/);
});

test('buildLengthHint: yêu cầu ngắn của người dùng được tôn trọng', () => {
  assert.match(buildLengthHint('giải thích TCP ngắn thôi'), /1–3 câu/);
  assert.match(buildLengthHint('tóm tắt súc tích'), /1–3 câu/);
});

test('buildLengthHint: nêu số cụ thể thì bám đúng số đó', () => {
  assert.match(buildLengthHint('viết 250 từ về TCP'), /250 từ/);
  assert.match(buildLengthHint('liệt kê 5 dòng'), /5 dòng/);
});

test('buildLengthHint: tin rỗng không nhắc gì', () => {
  assert.equal(buildLengthHint(''), '');
  assert.equal(buildLengthHint('   '), '');
});
