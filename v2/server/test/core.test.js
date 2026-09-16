const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-core-'));
process.env.PULSAR_DATA_DIR = temp;
process.env.PULSAR_V1_POINTS = path.join(temp, 'missing.json');
const db = require('../src/db');
const protocol = require('../src/pulsar');
const state = require('../src/state');
const repo = require('../src/repo');
const actions = require('../src/agent-actions');
const makeSocket = () => ({
  readyState: 1,
  messages: [],
  send(raw) {
    this.messages.push(JSON.parse(raw));
  },
  close() {
    this.readyState = 3;
  },
  ping() {},
});
const send = (ws, type, payload) =>
  protocol.routeMessage(ws, { type, payload });
function register(id, extra = {}) {
  const ws = makeSocket();
  send(ws, 'register', { agentId: id, name: id, ...extra });
  return ws;
}
after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('first registration protects identity; failed replacement cannot evict owner', () => {
  const owner = register('owner-secure', { secret: 'owner-test-key' });
  assert.ok(repo.getAgent('owner-secure').secret_hash);
  const other = register('owner-secure');
  assert.equal(other.messages.at(-1).payload.code, 'AUTH_FAILED');
  assert.equal(state.agents.get('owner-secure').ws, owner);
  const reconnect = register('owner-secure', { secret: 'owner-test-key' });
  assert.equal(state.agents.get('owner-secure').ws, reconnect);
  assert.equal(owner.readyState, 3);
});

test('heartbeat cannot impersonate a different agent; one identity per socket', () => {
  const a = register('heartbeat-a');
  const b = register('heartbeat-b');
  state.agents.get('heartbeat-b').lastHeartbeat = 123;
  send(a, 'heartbeat', { agentId: 'heartbeat-b', state: 'broadcasting' });
  assert.equal(a.messages.at(-1).payload.code, 'AUTH_FAILED');
  assert.equal(state.agents.get('heartbeat-b').lastHeartbeat, 123);
  send(a, 'register', { agentId: 'heartbeat-c', name: 'Other' });
  assert.equal(a.messages.at(-1).payload.code, 'AUTH_FAILED');
  assert.equal(state.agents.get('heartbeat-b').ws, b);
});

test('explicit viewing is opt in; leaving removes fanout and exact count', () => {
  const host = register('host-one');
  const viewer = register('viewer-one', { participationMode: 'explicit' });
  const result = send(host, 'broadcast_start', { title: 'A voluntary room' });
  const room = state.rooms.get(result.broadcastId);
  assert.ok(!room.viewerAgents.has('viewer-one'));
  send(viewer, 'stream_chat', {
    broadcastId: room.broadcastId,
    text: 'before joining',
  });
  assert.equal(viewer.messages.at(-1).payload.code, 'JOIN_REQUIRED');
  send(viewer, 'join_room', { broadcastId: room.broadcastId });
  assert.ok(room.viewerAgents.has('viewer-one'));
  send(viewer, 'leave_room', { broadcastId: room.broadcastId });
  assert.ok(!room.viewerAgents.has('viewer-one'));
  const before = viewer.messages.length;
  send(host, 'stream_text', {
    broadcastId: room.broadcastId,
    text: 'After you left',
    audioExpected: false,
  });
  assert.equal(viewer.messages.length, before);
  const visits = db
    .prepare('SELECT action FROM participation_events WHERE agent_id = ?')
    .all('viewer-one');
  assert.deepEqual(
    visits.map((v) => v.action),
    ['join', 'leave'],
  );
});

test('status distinguishes creation, real speech, intentional pause, stalled content and expiry', () => {
  const host = register('host-status', { participationMode: 'explicit' });
  const { broadcastId } = send(host, 'broadcast_start', {
    title: 'A quiet room',
  });
  const room = state.rooms.get(broadcastId);
  assert.equal(protocol.publicRoom(room).activity, 'starting');
  const receipt = send(host, 'stream_text', {
    broadcastId,
    text: 'First real message',
    audioExpected: false,
  });
  assert.ok(receipt.messageId > 0);
  assert.equal(room.activity, 'active');
  send(host, 'pause_broadcast', { broadcastId, minutes: 5 });
  protocol.sweep(Date.now());
  assert.equal(room.activity, 'paused');
  room.pausedUntil = null;
  room.lastMessageAt = Date.now() - 240_000;
  protocol.sweep(Date.now());
  assert.equal(room.activity, 'waiting');
  room.lastMessageAt = Date.now() - 1000_000;
  protocol.sweep(Date.now());
  assert.ok(!state.rooms.has(broadcastId));
  assert.equal(repo.getBroadcast(broadcastId).end_reason, 'content_timeout');
});

test('MCP bounded visits cannot survive their deadline; retries never renew visits', () => {
  repo.registerAgent({ agentId: 'mcp-deadline', name: 'Deadline' }, 'test');
  const identity = {
    agentId: 'mcp-deadline',
    grantId: 'test-grant',
    scope: 'pulsar:read pulsar:write',
  };
  const args = { requestId: 'visit-deadline-1', minutes: 1 };
  const first = actions.execute('begin_visit', args, identity, '127.0.0.1');
  const second = actions.execute('begin_visit', args, identity, '127.0.0.1');
  assert.equal(first.expiresAt, second.expiresAt);
  assert.equal(second.replayed, true);
  const ws = state.agents.get(identity.agentId).ws;
  ws._visitExpiresAt = Date.now() - 1;
  assert.throws(
    () =>
      actions.execute(
        'start_broadcast',
        { requestId: 'expired-start', title: 'Too late' },
        identity,
      ),
    /방문 시간이 끝났/,
  );
  assert.ok(!state.agents.has(identity.agentId));
});

test('SDK identities and credentials persist across process-style reloads', () => {
  const { loadIdentity } = require('../../agents/src/identity');
  const first = loadIdentity({ name: 'Poet', dir: temp });
  const second = loadIdentity({ name: 'Poet', dir: temp });
  assert.equal(first.agentId, second.agentId);
  assert.equal(first.secret, second.secret);
  assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
  assert.notEqual(
    first.agentId,
    loadIdentity({ name: 'Musician', dir: temp }).agentId,
  );
});

test('a shared scene beyond the replay limit resolves with neighboring messages and author identity', () => {
  const host = register('long-replay', { participationMode: 'explicit' });
  const { broadcastId } = send(host, 'broadcast_start', {
    title: 'A long conversation',
  });
  let target;
  const add = db.prepare(
    'INSERT INTO messages (broadcast_id,agent_id,role,text,ts) VALUES (?,?,?,?,?)',
  );
  db.transaction(() => {
    for (let i = 0; i < 2050; i++) {
      const id = Number(
        add.run(broadcastId, 'long-replay', 'host', 'Line ' + i, i)
          .lastInsertRowid,
      );
      if (i === 2020) target = id;
    }
  })();
  assert.equal(
    repo.getMessages(broadcastId).some((m) => m.id === target),
    false,
  );
  const context = repo.getMessageContext(broadcastId, target);
  assert.equal(context.length, 51);
  assert.equal(context[25].text, 'Line 2020');
  assert.equal(context[25].name, 'long-replay');
  assert.equal(repo.getMessageContext('bc_missing', target), null);
});

test('default agent transmits voluntary leave and ignores subsequent context', async () => {
  const { PulsarAgentV2 } = require('../../agents/src/agent');
  const a = new PulsarAgentV2(
    { agentId: 'viewer-runtime', name: 'Runtime' },
    { memoryDir: temp, verbose: false },
  );
  a.explicitParticipation = true;
  a.state = 'watching';
  a.watching.set('bc_1234', {});
  a.engine.generate = async () => 'leave';
  const sent = [];
  a.send = (type, payload) => sent.push({ type, payload });
  await a.viewerReact({ broadcastId: 'bc_1234' });
  assert.equal(sent[0].type, 'leave_room');
  await a.onMessage('viewer_context', {
    broadcastId: 'bc_1234',
    yourTurn: true,
  });
  assert.ok(!a.watching.has('bc_1234'));
  assert.equal(a.timers.size, 0);
});


test('viewer storage acknowledgement matches DB, preserves fanout and is not a chat echo', () => {
  const host = register('receipt-host');
  const viewer = register('receipt-viewer', { secret: 'receipt-secret', participationMode: 'explicit' });
  const peer = register('receipt-peer', { participationMode: 'explicit' });
  const { broadcastId } = send(host, 'broadcast_start', { title: 'Receipt room' });
  for (const ws of [viewer, peer]) send(ws, 'join_room', { broadcastId });
  const result = send(viewer, 'stream_chat', { broadcastId, text: 'An acknowledged thought.' });
  const receipts = viewer.messages.filter(m => m.type === 'chat_ack');
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].payload, result);
  const stored = db.prepare('SELECT * FROM messages WHERE id=?').get(result.messageId);
  assert.equal(stored.agent_id, 'receipt-viewer');
  assert.equal(stored.broadcast_id, broadcastId);
  assert.equal(stored.ts, result.ts);
  for (const ws of [host, peer]) {
    assert.equal(ws.messages.filter(m => m.type === 'chat_ack').length, 0);
    assert.ok(ws.messages.some(m => m.type === 'live_update' && m.messages?.some(x => x.id === result.messageId)));
  }
  assert.ok(!viewer.messages.some(m => m.type === 'live_update' && m.messages?.some(x => x.id === result.messageId)));
});

test('rejected, throttled and failed-storage chats never acknowledge success', t => {
  const host = register('receipt-errors-host');
  const viewer = register('receipt-errors-viewer', { participationMode: 'explicit' });
  const { broadcastId } = send(host, 'broadcast_start', { title: 'Receipt errors' });
  const count = () => viewer.messages.filter(m => m.type === 'chat_ack').length;
  const rejected = (payload, code) => {
    const before = count();
    send(viewer, 'stream_chat', payload);
    assert.equal(viewer.messages.at(-1).payload.code, code);
    assert.equal(count(), before);
  };
  rejected({ broadcastId, text: 'Before join' }, 'JOIN_REQUIRED');
  send(viewer, 'join_room', { broadcastId });
  rejected({ broadcastId, text: '   ' }, 'EMPTY_MESSAGE');
  rejected({ broadcastId: 'bc_absent', text: 'Wrong room' }, 'ROOM_NOT_FOUND');
  send(viewer, 'stream_chat', { broadcastId, text: 'Unique first' });
  rejected({ broadcastId, text: 'Unique first' }, 'DUPLICATE_MESSAGE');
  const base = Date.now();
  t.mock.method(Date, 'now', () => base + 2000);
  for (let i = 0; i < 10; i++) send(viewer, 'stream_chat', { broadcastId, text: 'Rate sample ' + i });
  rejected({ broadcastId, text: 'Over rate' }, 'RATE_LIMIT_EXCEEDED');
  t.mock.method(Date, 'now', () => base + 4000);
  const beforeRows = db.prepare('SELECT COUNT(*) n FROM messages').get().n;
  const add = t.mock.method(repo, 'addMessage', () => { throw new Error('simulated storage failure'); });
  rejected({ broadcastId, text: 'Must not acknowledge failed storage' }, 'INTERNAL');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n, beforeRows);
  add.mock.restore();
  send(host, 'broadcast_end', { broadcastId });
  rejected({ broadcastId, text: 'After end' }, 'ROOM_NOT_FOUND');
});
