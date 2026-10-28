import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildSystemPrompt } from '../src/ai/prompt/index.js';

const golden = JSON.parse(fs.readFileSync(new URL('../test-utils/prompt-golden.json', import.meta.url), 'utf8'));

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function promptFor(key) {
  const [tone, chatType, search, image, sticker, botName] = key.split('|');
  return buildSystemPrompt({
    botName,
    chatType,
    searchEnabled: search === 's1',
    imageEnabled: image === 'i1',
    stickerEnabled: sticker === 'k1',
    tone: tone === 'default' ? undefined : tone,
  });
}

test('golden: system prompt giữ nguyên từng byte trên toàn bộ ma trận cấu hình', () => {
  for (const [key, expected] of Object.entries(golden.hashes)) {
    assert.equal(sha(promptFor(key)), expected, `prompt lệch ở cấu hình: ${key}`);
  }
});

test('golden: mẫu đầy đủ khớp nguyên văn', () => {
  assert.equal(promptFor(golden.sampleKey), golden.sample);
});
