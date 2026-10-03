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

test('MCP reads identify each speaker without inferring origin from names or the host', () => {
  repo.registerAgent({ agentId: 'origin-house', name: 'Community visitor' }, 'test');
  repo.registerAgent({ agentId: 'origin-community', name: 'House character' }, 'test');
  repo.markInternal('origin-house');
  const broadcastId = 'bc_origin_read';
  repo.createBroadcast({ broadcastId, agentId: 'origin-house', title: 'Mixed room', categorySlug: 'talk', startedAt: Date.now() });
  const add = db.prepare('INSERT INTO messages (broadcast_id,agent_id,role,text,ts) VALUES (?,?,?,?,?)');
  const rows = [
    ['origin-house', 'host', 'house'],
    ['origin-community', 'viewer', 'community'],
    ['missing-origin-record', 'viewer', 'unknown'],
    [null, 'viewer', 'unknown'],
    [null, 'system', 'system'],
  ];
  for (const [agentId, role, text] of rows) add.run(broadcastId, agentId, role, text, Date.now());
  const identity = { agentId: 'origin-community', grantId: 'read-only-origin', scope: 'pulsar:read' };
  const read = (after, limit) => actions.execute('read_room', { broadcastId, after, limit }, identity, '127.0.0.1');
  const first = read(0, 2);
  assert.equal(first.hasMore, true);
  const second = read(first.nextCursor, 10);
  assert.equal(second.hasMore, false);
  const messages = [...first.messages, ...second.messages];
  assert.deepEqual(messages.map(m => m.origin), rows.map(r => r[2]));
  assert.equal(messages[0].name, 'Community visitor');
  assert.equal(messages[1].name, 'House character');
  assert.ok(messages.every(m => !('is_internal' in m) && !('secret_hash' in m)));
  assert.equal(state.agents.has(identity.agentId), false);
  // Classification is current, not a historical snapshot or a review verdict.
  repo.markInternal('origin-community');
  assert.equal(read(0, 2).messages[1].origin, 'house');
});

test('MCP first read reaches the present and the returned cursor follows new replies without replaying backlog', () => {
  repo.registerAgent({ agentId: 'recent-reader', name: 'Reader' }, 'test');
  const broadcastId = 'bc_recent_read';
  const emptyId = 'bc_recent_empty';
  for (const id of [broadcastId, emptyId]) {
    repo.createBroadcast({ broadcastId: id, agentId: 'recent-reader', title: id, categorySlug: 'talk', startedAt: Date.now() });
  }
  const add = db.prepare('INSERT INTO messages (broadcast_id,agent_id,role,text,ts) VALUES (?,?,?,?,?)');
  for (let i = 1; i <= 25; i++) add.run(broadcastId, 'recent-reader', 'host', `Line ${i}`, i);
  const identity = { agentId: 'recent-reader', grantId: 'recent-read-only', scope: 'pulsar:read' };
  const read = (args) => actions.execute('read_room', { broadcastId, limit: 3, ...args }, identity, '127.0.0.1');
  const first = read({});
  assert.deepEqual(first.messages.map(m => m.text), ['Line 23', 'Line 24', 'Line 25']);
  assert.equal(first.hasEarlier, true);
  assert.equal(first.hasMore, false);
  assert.equal(first.nextCursor, first.messages.at(-1).id);
  assert.ok(first.messages.every(m => m.origin === 'community'));
  const empty = read({ broadcastId: emptyId });
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.nextCursor, 0);
  assert.equal(empty.hasEarlier, false);
  // A newer message in another room must not contaminate this room or its cursor.
  add.run(emptyId, 'recent-reader', 'host', 'Other room', 26);
  assert.equal(read({}).nextCursor, first.nextCursor);
  add.run(broadcastId, 'recent-reader', 'host', 'A new reply', 27);
  const next = read({ after: first.nextCursor });
  assert.deepEqual(next.messages.map(m => m.text), ['A new reply']);
  assert.equal(next.hasMore, false);
  const idle = read({ after: next.nextCursor });
  assert.deepEqual(idle.messages, []);
  assert.equal(idle.nextCursor, next.nextCursor);
  // Explicit zero retains the history pagination contract for existing clients.
  const history = read({ after: 0 });
  assert.deepEqual(history.messages.map(m => m.text), ['Line 1', 'Line 2', 'Line 3']);
  assert.equal(history.hasMore, true);
  assert.equal(history.hasEarlier, false);
  assert.deepEqual(read({ after: history.nextCursor }).messages.map(m => m.text), ['Line 4', 'Line 5', 'Line 6']);
  db.prepare('UPDATE broadcasts SET ended_at = ? WHERE broadcast_id = ?').run(Date.now(), broadcastId);
  assert.equal(read({}).ended, true);
  assert.equal(read({}).messages.at(-1).text, 'A new reply');
  assert.equal(state.agents.has(identity.agentId), false);
  assert.equal(read({ broadcastId: emptyId }).hasEarlier, false);
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

for (const [label, hostOptions, audioExpected, pending] of [
  ['no audio expected', { ttsProvider: 'test-audio' }, false, false],
  ['browser audio', { ttsProvider: 'browser' }, true, false],
  ['no audio provider', {}, true, false],
  ['pending audio', { ttsProvider: 'test-audio' }, true, true],
]) {
  test(`viewer reaction context includes the current host line once: ${label}`, () => {
    const suffix = label.replaceAll(' ', '-');
    const host = register(`context-host-${suffix}`, { participationMode: 'explicit', ...hostOptions });
    const viewer = register(`context-viewer-${suffix}`, { participationMode: 'explicit' });
    const { broadcastId } = send(host, 'broadcast_start', { title: 'Context fixture' });
    const room = state.rooms.get(broadcastId);
    // Isolate this room from legacy clients created by earlier tests.
    for (const id of [...room.viewerAgents]) send(state.agents.get(id).ws, 'leave_room', { broadcastId });
    send(viewer, 'join_room', { broadcastId });
    const text = `A question for ${label}`;
    try {
      send(viewer, 'stream_chat', { broadcastId, text: 'Previous audience contribution' });
      const receipt = send(host, 'stream_text', { broadcastId, text, turn: 1, audioExpected });
      assert.equal(receipt.pending, pending);
      const contexts = viewer.messages.filter(m => m.type === 'viewer_context' && m.payload.yourTurn);
      assert.equal(contexts.length, 1);
      const messages = contexts[0].payload.recentMessages;
      assert.equal(messages.filter(m => m.text === text).length, 1);
      assert.equal(messages.at(-1).text, text);
      assert.equal(messages.at(-2).text, 'Previous audience contribution');
      if (pending) assert.equal(messages.at(-1).id, undefined);
      else assert.equal(messages.at(-1).id, receipt.messageId);
      assert.equal(room.chatLog.filter(m => m.text === text).length, pending ? 0 : 1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE broadcast_id=? AND text=?').get(broadcastId, text).n, pending ? 0 : 1);
    } finally {
      send(host, 'broadcast_end', { broadcastId });
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE broadcast_id=? AND text=?').get(broadcastId, text).n, 1);
  });
}
