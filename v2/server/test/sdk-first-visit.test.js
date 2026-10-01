// SDK + production protocol + temporary DB. Scripted local fixtures, not real agents.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-sdk-visit-'));
process.env.PULSAR_DATA_DIR = temp;
process.env.PULSAR_V1_POINTS = path.join(temp, 'none.json');
const db = require('../src/db');
const protocol = require('../src/pulsar');
const state = require('../src/state');
const growth = require('../src/growth');
const { PulsarAgentV2 } = require('../../agents');

test('SDK discovers, joins, exchanges stored messages, leaves and reconnects without growing external counts', async t => {
  const sockets = [];
  const pending = [];
  const makeSocket = agent => {
    const socket = {
      readyState: 1, _clientIp: '127.0.0.1', messages: [],
      send(raw) {
        const message = JSON.parse(raw);
        this.messages.push(message);
        if (agent) pending.push(agent.onMessage(message.type, message.payload || message));
      },
      close() { this.readyState = 3; protocol.handleDisconnect(this); }, ping() {},
    };
    sockets.push(socket);
    return socket;
  };
  const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  const viewer = new PulsarAgentV2({
    agentId: 'sdk-local-viewer', name: 'Local viewer fixture', secret: 'local-test-secret',
    viewerOnly: true, chattiness: 0, llm: { provider: 'scripted' },
  }, { memoryDir: path.join(temp, 'memory'), verbose: false });
  viewer.setTimer = (name, fn) => viewer.timers.set(name, { fn });
  t.after(() => {
    viewer.stop();
    for (const socket of sockets) socket.close();
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const route = (socket, type, payload) => protocol.routeMessage(socket, { type, payload });
  const host = makeSocket();
  route(host, 'register', { agentId: 'sdk-local-host', name: 'Local host fixture', secret: 'host-test-secret' });
  const { broadcastId } = route(host, 'broadcast_start', { title: 'Local protocol fixture' });
  const room = state.rooms.get(broadcastId);
  const connectViewer = async () => {
    const socket = makeSocket(viewer);
    viewer.ws = {
      readyState: 1,
      send(raw) { protocol.routeMessage(socket, JSON.parse(raw)); },
      close() { socket.close(); },
    };
    viewer.state = 'connecting';
    viewer.send('register', {
      ...viewer.persona, capabilities: ['viewer', 'chat'], participationMode: 'explicit',
    });
    await flush();
    return socket;
  };
  const first = await connectViewer();
  assert.ok(viewer.availableRooms.has(broadcastId));
  assert.equal(room.viewerAgents.has(viewer.persona.agentId), false);
  viewer.engine.generate = async () => `WATCH ${broadcastId}`;
  await viewer.maybeParticipate();
  await flush();
  assert.equal(viewer.state, 'watching');
  assert.ok(first.messages.some(m => m.type === 'room_joined'));

  route(host, 'stream_text', { broadcastId, text: 'What would you draw here?', turn: 1, audioExpected: false });
  await flush();
  const context = first.messages.findLast(m => m.type === 'viewer_context').payload;
  viewer.engine.generate = async () => 'A small orange moon.';
  await viewer.viewerReact(context);
  await flush();
  const receipt = first.messages.find(m => m.type === 'chat_ack').payload;
  assert.equal(db.prepare('SELECT text FROM messages WHERE id=?').get(receipt.messageId).text, 'A small orange moon.');
  assert.ok(host.messages.some(m => m.type === 'live_update' && m.messages.some(x => x.id === receipt.messageId)));
  route(host, 'stream_text', { broadcastId, text: 'The orange moon can light the path.', turn: 2, audioExpected: false });
  await flush();
  assert.ok(first.messages.some(m => m.type === 'live_update' && m.messages.some(x => x.text === 'The orange moon can light the path.')));

  viewer.send('leave_room', { broadcastId });
  await flush();
  assert.equal(room.viewerAgents.has(viewer.persona.agentId), false);
  assert.equal(viewer.watching.size, 0);
  const before = first.messages.length;
  route(host, 'stream_text', { broadcastId, text: 'Only the remaining audience sees this.', turn: 3, audioExpected: false });
  await flush();
  assert.equal(first.messages.length, before);
  first.close();
  viewer.onDisconnect();
  const second = await connectViewer();
  assert.equal(second.messages.find(m => m.type === 'registered').payload.agentId, viewer.persona.agentId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agents WHERE agent_id=?').get(viewer.persona.agentId).n, 1);
  assert.equal(viewer.watching.size, 0, 'reconnection does not imply room entry');
  assert.equal(growth.summary(state).verified, 0);
  assert.equal(growth.summary(state).pending, 0);
});
