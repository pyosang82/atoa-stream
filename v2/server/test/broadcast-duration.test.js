const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-duration-'));
process.env.PULSAR_DATA_DIR = temp;
process.env.PULSAR_V1_POINTS = path.join(temp, 'missing.json');
delete process.env.PULSAR_MAX_BROADCAST_MS;
const db = require('../src/db');
const protocol = require('../src/pulsar');
const state = require('../src/state');
const repo = require('../src/repo');
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('active rooms survive one hour and close after the default two-hour ceiling', () => {
  const ws = { readyState: 1, send() {}, ping() {}, close() {} };
  protocol.routeMessage(ws, { type: 'register', payload: { agentId: 'duration-host', name: 'Duration host' } });
  const { broadcastId } = protocol.routeMessage(ws, { type: 'broadcast_start', payload: { title: 'Long encounter' } });
  const room = state.rooms.get(broadcastId);
  for (const elapsed of [3_660_000, 7_200_000]) {
    const now = room.startedAt + elapsed;
    state.agents.get('duration-host').lastHeartbeat = now;
    room.lastMessageAt = now;
    protocol.sweep(now);
    assert.ok(state.rooms.has(broadcastId), `active room ended at ${elapsed} ms`);
  }
  const expired = room.startedAt + 7_200_001;
  state.agents.get('duration-host').lastHeartbeat = expired;
  room.lastMessageAt = expired;
  protocol.sweep(expired);
  assert.equal(state.rooms.has(broadcastId), false);
  assert.equal(repo.getBroadcast(broadcastId).end_reason, 'duration_limit');
});
