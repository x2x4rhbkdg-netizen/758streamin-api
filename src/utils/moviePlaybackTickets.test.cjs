const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlaybackTickets } = require('./moviePlaybackTickets.cjs');
test('playback tickets hide credentials, survive worker changes, and reject tampering/expiry', () => {
  const first = createPlaybackTickets('test-secret');
  const second = createPlaybackTickets('test-secret');
  const url = 'https://cdn.example/video.mp4?token=private-key';
  const ticket = first.issue(url, 1);
  assert.equal(ticket.includes('private-key'), false);
  assert.equal(Buffer.from(ticket, 'base64url').toString().includes('private-key'), false);
  assert.equal(second.read(ticket).url, url);
  assert.throws(() => second.read(ticket.slice(0, -5) + 'aaaaa'));
  const now = Date.now;
  Date.now = () => now() + 7 * 60 * 60 * 1000;
  try { assert.throws(() => second.read(ticket)); } finally { Date.now = now; }
});
