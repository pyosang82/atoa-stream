const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

// Synthetic room state only: no profiles, persisted broadcasts, OAuth or sockets.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-room-pages-'));
process.env.PULSAR_DATA_DIR = temp;
process.env.PULSAR_V1_POINTS = path.join(temp, 'missing.json');
const db = require('../src/db');
const state = require('../src/state');
const { createServer } = require('../src/mcp');
const server = createServer({ agentId: 'read-fixture', scope: 'pulsar:read' }, '127.0.0.1');
const client = new Client({ name: 'offline-room-pages', version: '1.0.0' });
const start = Date.parse('2026-10-03T00:00:00Z');
const id = n => 'bc_' + n.toString(16).padStart(16, '0');
function room(n, startedAt = start + n) {
  return { broadcastId: id(n), hostId: 'fixture-host-' + n,
    title: 'Synthetic room '.padEnd(200, 'x'), categorySlug: 'talk',
    tags: null, startedAt, viewerAgents: new Set(), turn: 0 };
}
before(async () => {
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
});
beforeEach(() => state.rooms.clear());
after(async () => {
  state.rooms.clear();
  await client.close();
  await server.close();
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
const call = args => client.callTool({ name: 'list_rooms', arguments: args });
async function page(args = {}) {
  const result = await call(args);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.ok(Array.isArray(result.structuredContent.rooms));
  assert.equal(typeof result.structuredContent.note, 'string');
  assert.equal(typeof result.structuredContent.hasMore, 'boolean');
  assert.equal(result.structuredContent.hasMore, result.structuredContent.nextCursor !== null);
  if (result.structuredContent.hasMore) assert.equal(typeof result.structuredContent.nextCursor, 'string');
  return result.structuredContent;
}

test('default discovery bounds a large room fixture without changing the existing shape', async t => {
  for (let n = 1; n <= 1000; n++) state.rooms.set(id(n), room(n));
  const result = await call({});
  t.diagnostic(JSON.stringify({ fixtureRooms: 1000, returnedRooms: result.structuredContent.rooms.length,
    serializedResultBytes: Buffer.byteLength(JSON.stringify(result)) }));
  assert.equal(result.structuredContent.rooms.length, 20);
  assert.equal(result.structuredContent.rooms[0].broadcastId, id(1));
  assert.equal(result.structuredContent.rooms[0].title, room(1).title);
  assert.match(result.structuredContent.note, /does not join/);
  assert.equal(result.structuredContent.hasMore, true);
  assert.equal(typeof result.structuredContent.nextCursor, 'string');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agents').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM broadcasts').get().n, 0);
});

test('bounded cursor pages expose every room once, including tied timestamps', async () => {
  for (let n = 123; n >= 1; n--) state.rooms.set(id(n), room(n, start + Math.floor(n / 3)));
  const seen = [];
  let cursor;
  do {
    const result = await page({ limit: 50, ...(cursor ? { cursor } : {}) });
    assert.ok(result.rooms.length <= 50);
    seen.push(...result.rooms.map(r => r.broadcastId));
    assert.ok(seen.length <= 123, 'Cursor must advance without repeating rooms');
    assert.equal(result.hasMore, result.nextCursor !== null);
    cursor = result.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, Array.from({ length: 123 }, (_, n) => id(n + 1)));
});

test('a closed cursor room does not prevent continuation or repeat earlier rooms', async () => {
  for (let n = 1; n <= 4; n++) state.rooms.set(id(n), room(n));
  const first = await page({ limit: 2 });
  state.rooms.delete(id(1));
  state.rooms.delete(id(2));
  state.rooms.set(id(5), room(5));
  const next = await page({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(next.rooms.map(r => r.broadcastId), [id(3), id(4)]);
  const last = await page({ limit: 2, cursor: next.nextCursor });
  assert.deepEqual(last.rooms.map(r => r.broadcastId), [id(5)]);
  assert.equal(last.nextCursor, null);
});

test('empty and small zero-argument calls keep rooms and note with an explicit end', async () => {
  assert.deepEqual((await page()).rooms, []);
  state.rooms.set(id(1), room(1));
  const result = await page();
  assert.deepEqual(result.rooms.map(r => r.broadcastId), [id(1)]);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextCursor, null);
});

test('minimum, exact default and maximum pages terminate at their real boundaries', async () => {
  for (let n = 1; n <= 20; n++) state.rooms.set(id(n), room(n));
  assert.equal((await page()).nextCursor, null);
  const minimum = await page({ limit: 1 });
  assert.equal(minimum.rooms.length, 1);
  assert.equal(minimum.hasMore, true);
  for (let n = 21; n <= 50; n++) state.rooms.set(id(n), room(n));
  const maximum = await page({ limit: 50 });
  assert.equal(maximum.rooms.length, 50);
  assert.equal(maximum.nextCursor, null);
});

test('closing all remaining rooms returns an empty terminal page', async () => {
  for (let n = 1; n <= 3; n++) state.rooms.set(id(n), room(n));
  const first = await page({ limit: 1 });
  state.rooms.clear();
  const last = await page({ limit: 1, cursor: first.nextCursor });
  assert.deepEqual(last.rooms, []);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextCursor, null);
});

test('invalid limits and cursors produce actionable errors instead of unbounded fallbacks', async () => {
  for (const limit of [0, 51, 1.5]) {
    const result = await call({ limit });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /limit/);
  }
  for (const cursor of ['', null, 1, 'x'.repeat(161), 'not a cursor']) {
    const result = await call({ cursor });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /cursor/);
  }
  for (const cursor of ['invalid', Buffer.from('null').toString('base64url'),
    Buffer.from(JSON.stringify([-1, id(1)])).toString('base64url')]) {
    const result = await call({ cursor });
    assert.equal(result.isError, true);
    const error = JSON.parse(result.content[0].text);
    assert.equal(error.code, 'INVALID_CURSOR');
    assert.match(error.message, /nextCursor/);
  }
});
