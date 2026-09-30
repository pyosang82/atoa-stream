const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PulsarAgentV2 } = require(path.join(process.env.PULSAR_AGENT_TEST_ROOT || path.join(__dirname, '..'), 'src/agent'));

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-reconnect-'));
  const agent = new PulsarAgentV2({ agentId: 'reconnect-test', name: 'Local test', llm: { provider: 'scripted' } },
    { memoryDir: dir, verbose: false });
  agent.ws = {};
  agent.state = 'idle';
  agent.explicitParticipation = true;
  agent.setTimer = (name, fn) => agent.timers.set(name, { fn });
  const sent = [];
  agent.send = (type, payload) => sent.push({ type, payload });
  t.after(() => { agent.clearAllTimers([]); fs.rmSync(dir, { recursive: true, force: true }); });
  return { agent, sent };
}
const room = id => ({ broadcastId: id, title: 'Local test room' });
const registered = (agent, rooms) => agent.onMessage('registered', {
  features: ['explicit_participation'], activeRooms: rooms,
});

test('disconnect discards stale discovery and registration replaces the room snapshot', async t => {
  const { agent } = setup(t);
  agent.availableRooms.set('bc_aaaa', room('bc_aaaa'));
  agent.knownRoomCount = 1;
  agent.onDisconnect();
  assert.equal(agent.availableRooms.size, 0);
  assert.equal(agent.knownRoomCount, 0);
  agent.availableRooms.set('bc_dead', room('bc_dead'));
  await registered(agent, [room('bc_bbbb')]);
  assert.deepEqual([...agent.availableRooms.keys()], ['bc_bbbb']);
  assert.equal(agent.knownRoomCount, 1);
  await registered(agent, []);
  assert.equal(agent.availableRooms.size, 0);
  assert.equal(agent.knownRoomCount, 0);
});

test('a room that closes during a choice is not joined; a later open room still can be', async t => {
  const { agent, sent } = setup(t);
  await registered(agent, [room('bc_aaaa')]);
  let finish;
  agent.engine.generate = () => new Promise(resolve => { finish = resolve; });
  const choosing = agent.maybeParticipate();
  await agent.onMessage('broadcast_ended', { broadcastId: 'bc_aaaa' });
  finish('WATCH bc_aaaa');
  await choosing;
  assert.deepEqual(sent, []);
  await agent.onMessage('heartbeat_ack', { activeRooms: [room('bc_bbbb')] });
  agent.engine.generate = async () => 'WATCH bc_bbbb';
  await agent.maybeParticipate();
  assert.deepEqual(sent, [{ type: 'join_room', payload: { broadcastId: 'bc_bbbb' } }]);
});

test('a choice generated on a disconnected socket cannot start a broadcast on its replacement', async t => {
  const { agent, sent } = setup(t);
  let finish;
  agent.engine.generate = () => new Promise(resolve => { finish = resolve; });
  const choosing = agent.maybeParticipate();
  agent.onDisconnect();
  agent.ws = {};
  await registered(agent, []);
  finish('HOST An obsolete choice');
  await choosing;
  assert.deepEqual(sent, []);
  assert.equal(agent.choosingActivity, false);
  agent.engine.generate = async () => 'HOST A new conversation';
  await agent.maybeParticipate();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'broadcast_start');
  assert.equal(sent[0].payload.title, 'A new conversation');
});
