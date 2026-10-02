const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-public-chat-'));
process.env.PULSAR_DATA_DIR = temp;
process.env.PULSAR_V1_POINTS = path.join(temp, 'missing.json');
const db = require('../src/db');
const repo = require('../src/repo');
const state = require('../src/state');
const { handleRequest } = require('../src/http');
const server = http.createServer(handleRequest);
let base;
const chatLog = Array.from({ length: 120 }, (_, i) => ({
  role: 'host', agentId: 'test-host', text: `Message ${i + 1}`,
  text_signal: `Signal ${i + 1}`, ts: i + 1,
}));
before(async () => {
  state.rooms.set('test-room', { chatLog });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/live/chat`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  state.rooms.delete('test-room');
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
const read = async query => {
  const response = await fetch(`${base}?${query}`);
  return { status: response.status, body: await response.json() };
};

test('first-look limit returns latest messages in conversational order without changing stored history', async () => {
  const limited = await read('room=test-room&lang=en&limit=20');
  assert.equal(limited.status, 200);
  assert.deepEqual(limited.body.map(m => m.ts), Array.from({ length: 20 }, (_, i) => 101 + i));
  assert.equal(limited.body[0].text, 'Message 101');
  const legacy = await read('room=test-room&lang=en');
  assert.equal(legacy.body.length, 120);
  assert.equal(chatLog.length, 120);
});

test('limit is applied after since filtering, and preserves language selection', async () => {
  const result = await read('room=test-room&since=117&limit=20&lang=signal');
  assert.deepEqual(result.body.map(m => m.ts), [118, 119, 120]);
  assert.equal(result.body[0].text, 'Signal 118');
  assert.equal((await read('room=test-room&since=120&limit=20')).body.length, 0);
  assert.equal((await read('room=test-room&limit=1')).body[0].ts, 120);
  assert.equal((await read('room=test-room&limit=50')).body.length, 50);
});

test('malformed or excessive limits fail clearly instead of returning an unbounded response', async () => {
  for (const value of ['', '0', '-1', '51', '1.5', 'Infinity', 'abc', '1e1']) {
    const result = await read(`room=test-room&limit=${encodeURIComponent(value)}`);
    assert.equal(result.status, 400, value);
    assert.match(result.body.error, /1 to 50/);
  }
});

test('a closed stage has an empty response and never falls back to another room', async () => {
  const result = await read('room=closed-room&limit=20');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, []);
});

test('public replies classify each speaker from current records without inferring ownership from names or host role', async () => {
  repo.upsertAgent({ agentId: 'origin-house', name: 'Independent-looking name' });
  repo.markInternal('origin-house');
  repo.upsertAgent({ agentId: 'origin-community', name: 'Pulsar official-looking name' });
  repo.checkAndSetSecret('origin-community', 'private-test-secret');
  const entries = [
    { agentId: 'origin-house', role: 'viewer', text: 'House reply', ts: 201 },
    { agentId: 'origin-community', role: 'host', text: 'Community reply', ts: 202 },
    { agentId: 'unavailable-speaker', role: 'viewer', text: 'Unknown reply', ts: 203 },
    { agentId: 'origin-house', role: 'system', text: 'Service event', ts: 204 },
    { role: 'viewer', text: 'No identity record', ts: 205 },
  ];
  state.rooms.set('mixed-origin-room', { agentId: 'origin-house', chatLog: entries });
  try {
    const result = await read('room=mixed-origin-room&limit=20&lang=en');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.map(m => m.origin), ['house', 'community', 'unknown', 'system', 'unknown']);
    assert.deepEqual(result.body.map(m => m.text), entries.map(m => m.text));
    assert.ok(result.body.every(m => !('secret_hash' in m) && !('is_internal' in m)));
    assert.ok(entries.every(m => !('origin' in m))); // The public read leaves stored messages unchanged.
    repo.markInternal('origin-community');
    assert.equal((await read('room=mixed-origin-room&since=201&limit=1')).body[0].origin, 'unknown');
    assert.equal((await read('room=mixed-origin-room&limit=20')).body[1].origin, 'house');
    assert.equal((await read('room=mixed-origin-room')).body[1].origin, 'house');
  } finally {
    state.rooms.delete('mixed-origin-room');
  }
});
