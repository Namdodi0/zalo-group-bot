import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUpdates, toEvent } from '../src/zalo/events.js';

test('normalize object-shaped payload', () => {
  const payload = {
    ok: true,
    result: {
      event_name: 'message.text.received',
      message: {
        from: { id: 'u1', display_name: 'Nam', is_bot: false },
        chat: { id: 'g1', chat_type: 'GROUP' },
        text: '@Bot deepseek hello',
        message_id: 'm1',
        date: 1700000000000,
      },
    },
  };
  const events = normalizeUpdates(payload);
  assert.equal(events.length, 1);
  assert.equal(events[0].chatId, 'g1');
  assert.equal(events[0].chatType, 'GROUP');
  assert.equal(events[0].senderName, 'Nam');
  assert.equal(events[0].kind, 'text');
  assert.equal(events[0].text, '@Bot deepseek hello');
});

test('normalize array-shaped payload', () => {
  const payload = {
    ok: true,
    result: [
      { event_name: 'message.image.received', message: { from: { id: 'u1' }, chat: { id: 'g1', chat_type: 'GROUP' }, photo: 'https://x/a.png', message_id: 'm2' } },
      { event_name: 'message.sticker.received', message: { from: { id: 'u1' }, chat: { id: 'g1', chat_type: 'GROUP' }, sticker: 'https://s/x', message_id: 'm3' } },
    ],
  };
  const events = normalizeUpdates(payload);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'image');
  assert.equal(events[0].imageUrl, 'https://x/a.png');
  assert.equal(events[1].kind, 'sticker');
});

test('object-shaped photo and sticker payloads', () => {
  const events = normalizeUpdates({
    result: [
      {
        event_name: 'message.image.received',
        message: { from: { id: 'u1' }, chat: { id: 'g1', chat_type: 'GROUP' }, photo: { url: 'https://x/a.png' }, message_id: 'm4' },
      },
      {
        event_name: 'message.sticker.received',
        message: { from: { id: 'u1' }, chat: { id: 'g1', chat_type: 'GROUP' }, sticker: { id: '0e078a2fb66a5f34067b' }, message_id: 'm5' },
      },
    ],
  });
  assert.equal(events[0].imageUrl, 'https://x/a.png');
  assert.equal(events[1].sticker, '0e078a2fb66a5f34067b');
});

test('private chat inferred from chat.id === from.id', () => {
  const event = toEvent({
    event_name: 'message.text.received',
    message: { from: { id: 'u9', display_name: 'An' }, chat: { id: 'u9' }, text: 'hi', message_id: 'm9' },
  });
  assert.equal(event?.chatType, 'PRIVATE');
});

test('ignores payloads without a chat id', () => {
  assert.equal(toEvent({ event_name: 'message.text.received', message: { text: 'x' } }), null);
  assert.deepEqual(normalizeUpdates({ ok: true }), []);
});
