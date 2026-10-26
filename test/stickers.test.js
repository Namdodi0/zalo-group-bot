import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_STICKERS,
  createStickerStore,
  isValidStickerId,
  normalizeText,
  parseStickerIds,
} from '../src/ai/stickers.js';
import { silentLogger } from '../test-utils/helpers.js';

test('normalizeText bỏ dấu để tìm "meo" khớp "Mèo"', () => {
  assert.equal(normalizeText('Mèo Méo Meo'), 'meo meo meo');
  assert.equal(normalizeText('Đồng bọn'), 'dong bon');
});

test('validate + parse STICKER_IDS', () => {
  assert.equal(isValidStickerId('0e078a2fb66a5f34067b'), true);
  assert.equal(isValidStickerId('XYZ'), false);
  assert.equal(isValidStickerId('0e078a2fb66a5f34067'), false);

  const parsed = parseStickerIds('0e078a2fb66a5f34067b, aaaaaaaaaaaaaaaaaaaa:Vui vẻ , hong-hop');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, '0e078a2fb66a5f34067b');
  assert.equal(parsed[1].name, 'Vui vẻ');
});

test('tìm sticker built-in theo cảm xúc, tên và id', () => {
  const store = createStickerStore();
  assert.equal(store.find('chào').id, BUILTIN_STICKERS[0].id);
  assert.equal(store.find('0e078a2fb66a5f34067b').name, BUILTIN_STICKERS[0].name);
  assert.equal(store.find('không có gì'), null);
  assert.ok(store.random().id);
});

test('thêm/xoá sticker và lưu qua restart', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-stickers-'));
  const file = path.join(dir, 'stickers.json');
  const store = createStickerStore({ file, logger: silentLogger });
  await store.load();

  const added = await store.add({ id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Cảm Ơn Nhiều', tags: ['cam-on'] });
  assert.equal(added.added, true);
  assert.equal(store.find('cam on').id, 'aaaaaaaaaaaaaaaaaaaa');
  assert.equal(store.find('cam on nhieu').name, 'Cảm Ơn Nhiều');

  const duplicate = await store.add({ id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Trùng' });
  assert.equal(duplicate.added, false);

  const store2 = createStickerStore({ file, logger: silentLogger });
  await store2.load();
  assert.equal(store2.find('aaaaaaaaaaaaaaaaaaaa').name, 'Cảm Ơn Nhiều');

  const removed = await store2.remove('cam on nhieu');
  assert.equal(removed.id, 'aaaaaaaaaaaaaaaaaaaa');
  assert.equal(store2.find('aaaaaaaaaaaaaaaaaaaa'), null);
});

test('STICKER_IDS khai báo sẵn được nạp vào store', () => {
  const store = createStickerStore({
    extraIds: [{ id: 'bbbbbbbbbbbbbbbbbbbb', name: 'Cảm ơn' }],
  });
  assert.ok(store.find('cảm ơn'));
  assert.equal(store.size(), BUILTIN_STICKERS.length + 1);
});

test('add từ chối id không hợp lệ', async () => {
  const store = createStickerStore();
  await assert.rejects(() => store.add({ id: 'khong-hop-le' }), /20 ký tự hex/);
});
