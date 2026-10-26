import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchContext, buildSystemPrompt, SUMMARY_SYSTEM_PROMPT } from '../src/ai/prompt.js';

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

test('không còn giới hạn độ dài trả lời trong prompt', () => {
  const prompt = groupPrompt();
  assert.equal(/at most \d+ characters/.test(prompt), false);
  assert.equal(prompt.includes('3 paragraphs'), false);
  assert.match(prompt, /no preamble/);
  assert.match(prompt, /Match the depth the question deserves/);
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
