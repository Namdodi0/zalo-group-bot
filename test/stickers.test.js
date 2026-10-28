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

test('normalizeText strips diacritics so an unaccented query still matches', () => {
  assert.equal(normalizeText('M\u00e8o M\u00e9o Meo'), 'meo meo meo');
  assert.equal(normalizeText('\u0110\u1ed3ng b\u1ecdn'), 'dong bon');
});

test('validate + parse STICKER_IDS', () => {
  assert.equal(isValidStickerId('0e078a2fb66a5f34067b'), true);
  assert.equal(isValidStickerId('XYZ'), false);
  assert.equal(isValidStickerId('0e078a2fb66a5f34067'), false);

  const parsed = parseStickerIds('0e078a2fb66a5f34067b, aaaaaaaaaaaaaaaaaaaa:Happy vibes , bad-hex');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, '0e078a2fb66a5f34067b');
  assert.equal(parsed[1].name, 'Happy vibes');
});

test('finds built-in stickers by mood, name and id', () => {
  const store = createStickerStore();
  assert.equal(store.find('greeting').id, BUILTIN_STICKERS[0].id);
  assert.equal(store.find('0e078a2fb66a5f34067b').name, BUILTIN_STICKERS[0].name);
  assert.equal(store.find('nothing here'), null);
  assert.ok(store.random().id);
});

test('adds and removes stickers and persists them across a restart', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalo-stickers-'));
  const file = path.join(dir, 'stickers.json');
  const store = createStickerStore({ file, logger: silentLogger });
  await store.load();

  const added = await store.add({ id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Thank You Very Much', tags: ['thanks'] });
  assert.equal(added.added, true);
  assert.equal(store.find('thanks').id, 'aaaaaaaaaaaaaaaaaaaa');
  assert.equal(store.find('thank you very much').name, 'Thank You Very Much');

  const duplicate = await store.add({ id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Duplicate' });
  assert.equal(duplicate.added, false);

  const store2 = createStickerStore({ file, logger: silentLogger });
  await store2.load();
  assert.equal(store2.find('aaaaaaaaaaaaaaaaaaaa').name, 'Thank You Very Much');

  const removed = await store2.remove('thank you very much');
  assert.equal(removed.id, 'aaaaaaaaaaaaaaaaaaaa');
  assert.equal(store2.find('aaaaaaaaaaaaaaaaaaaa'), null);
});

test('predeclared STICKER_IDS are loaded into the store', () => {
  const store = createStickerStore({
    extraIds: [{ id: 'bbbbbbbbbbbbbbbbbbbb', name: 'Thanks' }],
  });
  assert.ok(store.find('thanks'));
  assert.equal(store.size(), BUILTIN_STICKERS.length + 1);
});

test('add rejects an invalid id', async () => {
  const store = createStickerStore();
  await assert.rejects(() => store.add({ id: 'not-valid' }), /20 hex characters/);
});
