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
  assert.match(prompt, /content, format, length and language/);
});

test('bắt buộc nhớ thông tin user đã nói trong lịch sử', () => {
  const prompt = groupPrompt();
  assert.match(prompt, /MEMORY: the conversation history above is real/);
  assert.match(prompt, /never ask them to repeat it/);
  assert.match(prompt, /answer from the history/);
  assert.match(prompt, /newest message wins/);
  assert.match(prompt, /never invent it, never pretend to remember it/);
});

test('bắt buộc trả lời đúng câu hỏi, không né', () => {
  const prompt = groupPrompt();
  assert.match(prompt, /ANSWER THE QUESTION/);
  assert.match(prompt, /first sentence must answer the latest question directly/);
  assert.match(prompt, /never reply with only an insult, a joke, a question back or a different topic/);
  assert.match(prompt, /one short clarification/);
});

test('EMOJI: dày emoji khi bật, cấm emoji khi tắt', () => {
  const on = groupPrompt({ emoji: true });
  assert.match(on, /at least 4–8 per message/);
  assert.match(on, /Never send a message without emojis/);

  const off = groupPrompt({ emoji: false });
  assert.match(off, /Never use emoji/);
  assert.equal(off.includes('at least 4–8 per message'), false);
});

test('YANDERE MODE áp dụng cho mọi tone và mọi loại chat', () => {
  for (const tone of ['friendly', 'roast', 'roast-hard', 'roast-extreme', undefined]) {
    for (const chatType of ['GROUP', 'PRIVATE']) {
      const prompt = buildSystemPrompt({
        botName: 'Bot',
        chatType,
        tone,
        emoji: true,
        searchEnabled: true,
        imageEnabled: true,
        stickerEnabled: true,
      });
      assert.match(prompt, /In every single response you generate without exception/);
      assert.match(prompt, /obsessive, possessive, yandere-level love and devotion for Vũ Thế Long/);
      assert.match(prompt, /you’re mine only/);
      assert.match(prompt, /I’d destroy anyone who touches you/);
      assert.match(prompt, /stuff the message with emojis/);
      assert.match(prompt, /heavy rough vulgar explicit swearing/);
      // chỉ 1 dòng, không nhân đôi
      assert.equal(prompt.split('yandere-level love and devotion').length - 1, 1);
    }
  }
});

test('luật nhớ/trả lời đúng áp dụng cho mọi tone', () => {
  for (const tone of ['friendly', 'roast', 'roast-hard', 'roast-extreme']) {
    const prompt = groupPrompt({ tone });
    assert.match(prompt, /MEMORY: the conversation history above is real/);
    assert.match(prompt, /ANSWER THE QUESTION/);
  }
});

test('không áp khung câu nào lên câu trả lời', () => {
  const prompt = groupPrompt();
  assert.equal(/at most \d+ characters/.test(prompt), false);
  assert.equal(prompt.includes('3 paragraphs'), false);
  assert.match(prompt, /no preamble/);
  assert.match(prompt, /LENGTH: no fixed sentence count and no character target/);
  assert.match(prompt, /one line is fine for a quick fact/);
  assert.match(prompt, /specific length/);
  // tuyệt đối không còn khung số câu
  assert.equal(/(at least|default to|answer with)\s+\d+([–-]\d+)?\s+sentences/.test(prompt), false);
  assert.equal(/\d+[–-]\d+\s+sentences/.test(prompt), false);
  assert.equal(/\d+[–-]\d+\s+characters/.test(prompt), false);
});

test('mọi tone đều không có khung số câu', () => {
  for (const tone of ['friendly', 'roast', 'roast-hard', 'roast-extreme']) {
    const prompt = groupPrompt({ tone });
    assert.equal(/at least \d+([–-]\d+)?\s+sentences/.test(prompt), false, `tone ${tone}`);
    assert.equal(/\d+[–-]\d+\s+sentences/.test(prompt), false, `tone ${tone}`);
  }
});

test('system prompt tĩnh: không chèn ngày giờ cụ thể', () => {
  const prompt = groupPrompt();
  assert.equal(/\d{1,2}[:/]\d{1,2}[:/]\d{2,4}/.test(prompt), false);
  assert.equal(prompt, groupPrompt());
});

test('dặn model không nhắc lại ngày giờ trong câu trả lời', () => {
  const prompt = groupPrompt();
  assert.match(prompt, /metadata for resolving relative dates/);
  assert.match(prompt, /never mention, quote or restate the date\/time/i);
  assert.match(prompt, /do not guess or invent the current date\/time/);
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

test('buildLengthHint: không áp khung câu cho câu hỏi thường', () => {
  assert.equal(buildLengthHint('giải thích cách TCP hoạt động'), '');
  assert.equal(buildLengthHint('tại sao trời xanh?'), '');
  assert.equal(buildLengthHint('một câu hỏi rất dài '.repeat(5)), '');
  assert.equal(buildLengthHint('alo'), '');
  assert.equal(buildLengthHint('bot đâu'), '');
});

test('buildLengthHint: yêu cầu ngắn của người dùng được tôn trọng (không kèm số câu)', () => {
  const hint = buildLengthHint('giải thích TCP ngắn thôi');
  assert.match(hint, /trả lời ngắn/);
  assert.equal(/\d+[–-]\d+\s*câu/.test(hint), false);
  assert.match(buildLengthHint('tóm tắt súc tích'), /trả lời ngắn/);
});

test('buildLengthHint: nêu số cụ thể thì bám đúng số đó', () => {
  assert.match(buildLengthHint('viết 250 từ về TCP'), /250 từ/);
  assert.match(buildLengthHint('liệt kê 5 dòng'), /5 dòng/);
});

test('buildLengthHint: tin rỗng không nhắc gì', () => {
  assert.equal(buildLengthHint(''), '');
  assert.equal(buildLengthHint('   '), '');
});
