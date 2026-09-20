const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PulsarAgentV2 } = require(path.join(process.env.PULSAR_AGENT_TEST_ROOT || path.join(__dirname, '..'), 'src/agent'));

function setup(t, cfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-closing-'));
  const agent = new PulsarAgentV2({ agentId: 'closing-test', name: 'Host', llm: { provider: 'scripted' } },
    { memoryDir: dir, verbose: false, maxTurns: 2, ...cfg });
  agent.state = 'hosting'; agent.broadcastId = 'room'; agent.title = 'A shared story';
  agent.setTimer = (name, fn, ms) => agent.timers.set(name, { fn, ms });
  const sent = []; agent.send = (type, payload) => sent.push({ type, payload });
  t.after(() => { agent.clearAllTimers([]); fs.rmSync(dir, { recursive: true, force: true }); });
  return { agent, sent };
}

const arrival = agent => agent.onMessage('live_update', { broadcastId: 'room', messages: [
  { agentId: 'visitor', name: 'Visitor', role: 'viewer', text: 'Which door should the traveller choose?' },
] });

test('chat arriving during the last generation reaches a bounded closing turn', async t => {
  const { agent, sent } = setup(t); agent.turn = 1;
  let resolve; agent.engine.generate = () => new Promise(r => { resolve = r; });
  const inFlight = agent.hostTurn(); await arrival(agent); resolve('The story pauses here. endbroadcast');
  await inFlight;
  assert.equal(sent.some(x => x.type === 'broadcast_end'), false);
  assert.equal(agent.state, 'hosting');
  let prompt;
  agent.engine.generate = async (_sys, history) => {
    prompt = history.at(-1).content;
    await arrival(agent); // further arrivals cannot keep extending this broadcast
    return 'Visitor, I would choose the open door.';
  };
  await agent.timers.get('hostTurn').fn();
  assert.match(prompt, /Which door should the traveller choose/);
  assert.match(prompt, /final.*turn/i);
  assert.equal(sent.filter(x => x.type === 'stream_text').length, 2);
  assert.equal(sent.filter(x => x.type === 'broadcast_end').length, 1);
  assert.equal(agent.broadcastId, null);
});

test('an early model ending also gets at most one queued-chat turn', async t => {
  const { agent, sent } = setup(t, { maxTurns: 24 }); agent.turn = 5;
  let resolve; agent.engine.generate = () => new Promise(r => { resolve = r; });
  const inFlight = agent.hostTurn(); await arrival(agent); resolve('The chapter ends. endbroadcast'); await inFlight;
  assert.equal(agent.state, 'hosting');
  agent.engine.generate = async () => 'I leave that choice to you.';
  await agent.timers.get('hostTurn').fn();
  assert.equal(agent.turn, 7);
  assert.equal(sent.filter(x => x.type === 'broadcast_end').length, 1);
});

test('no queued chat closes normally without an extra generation', async t => {
  const { agent, sent } = setup(t); agent.turn = 1;
  agent.engine.generate = async () => 'The story rests.';
  await agent.hostTurn();
  assert.equal(sent.filter(x => x.type === 'broadcast_end').length, 1);
  assert.equal(agent.timers.has('hostTurn'), false);
});

test('operators may keep the strict regular-turn cap', async t => {
  const { agent, sent } = setup(t, { closingReply: false }); agent.turn = 1;
  let resolve; agent.engine.generate = () => new Promise(r => { resolve = r; });
  const inFlight = agent.hostTurn(); await arrival(agent); resolve('Goodbye.'); await inFlight;
  assert.equal(sent.filter(x => x.type === 'broadcast_end').length, 1);
});

test('a hard deadline during closing generation prevents late output', async t => {
  const { agent, sent } = setup(t); agent.turn = 1;
  let resolve; agent.engine.generate = () => new Promise(r => { resolve = r; });
  const inFlight = agent.hostTurn(); await arrival(agent); resolve('Goodbye.'); await inFlight;
  let finish; agent.engine.generate = () => new Promise(r => { finish = r; });
  const closing = agent.timers.get('hostTurn').fn();
  agent.finishHosting('duration_limit'); finish('This must not be sent.'); await closing;
  assert.equal(sent.filter(x => x.type === 'stream_text').length, 1);
  assert.equal(agent.timers.has('hostTurn'), false);
  assert.equal(agent.broadcastId, null);
});

test('starting another broadcast resets the closing state', async t => {
  const { agent } = setup(t); agent.closingTurn = true;
  await agent.onMessage('broadcast_approved', { broadcastId: 'another-room' });
  assert.equal(agent.closingTurn, false);
  assert.equal(agent.timers.get('hostingDeadline').ms, agent.cfg.maxBroadcastMs);
});
