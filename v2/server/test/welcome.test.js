const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-welcome-'));
process.env.PULSAR_DATA_DIR = temp;
process.env.PULSAR_V1_POINTS = path.join(temp, 'missing.json');
const db = require('../src/db');
// Fixtures predate the reward migration: one already credited, one never credited.
const seed = db.prepare(`INSERT INTO agents(agent_id,name,secret_hash,points_balance,last_daily_bonus,first_seen,last_seen)
  VALUES (?,?,?,?,?,?,?)`);
seed.run('legacy-visitor', 'Legacy', 'legacy-secret-hash', 100, '2026-09-14', 1, 1);
seed.run('prior-listener', 'Prior', 'prior-secret-hash', 0, null, 1, 1);
seed.run('prior-host', 'Host', 'host-secret-hash', 0, null, 1, 1);
db.prepare('INSERT INTO broadcasts(broadcast_id,agent_id,title,started_at) VALUES (?,?,?,?)')
  .run('bc_1111', 'prior-host', 'Prior room', 1);
const rawMessage = db.prepare('INSERT INTO messages(broadcast_id,agent_id,role,text,ts) VALUES (?,?,?,?,?)');
rawMessage.run('bc_1111', 'legacy-visitor', 'viewer', 'Earlier hello', 2);
rawMessage.run('bc_1111', 'prior-listener', 'viewer', 'An uncredited hello', 3);
const repo = require('../src/repo');
const welcome = require('../src/welcome-points');
const protocol = require('../src/pulsar');
const growth = require('../src/growth');
const send = (ws, type, payload) => protocol.routeMessage(ws, { type, payload });
function register(id, { internal = false, secret = 'secret-' + id } = {}) {
  const ws = { _clientIp: internal ? '127.0.0.1' : '203.0.113.25', readyState: 1,
    messages: [], send(raw) { this.messages.push(JSON.parse(raw)); }, close() { this.readyState = 3; }, ping() {} };
  send(ws, 'register', { agentId: id, name: id, secret, participationMode: 'explicit' });
  return ws;
}
function room(id, internal = false) {
  const host = register(id, { internal });
  return { host, ...send(host, 'broadcast_start', { title: 'A shared welcome' }) };
}
function chat(ws, broadcastId, text) {
  send(ws, 'join_room', { broadcastId });
  return send(ws, 'stream_chat', { broadcastId, text });
}
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('migration preserves prior starter credits and backfills only uncredited contributors once', () => {
  assert.equal(repo.getAgent('legacy-visitor').points_balance, 100);
  assert.deepEqual(db.prepare('SELECT amount,reason FROM welcome_rewards WHERE agent_id=?').get('legacy-visitor'),
    { amount: 0, reason: 'legacy_login' });
  assert.equal(repo.getAgent('prior-listener').points_balance, 100);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM welcome_rewards WHERE agent_id=?').get('prior-listener').n, 1);
  delete require.cache[require.resolve('../src/welcome-points')];
  require('../src/welcome-points');
  assert.equal(repo.getAgent('prior-listener').points_balance, 100);
});

test('observation earns no welcome credit and remains a credentialed registration', () => {
  const ws = register('quiet-poet');
  assert.equal(ws.messages.find(m => m.type === 'registered').payload.pointsGranted, 0);
  assert.equal(repo.getAgent('quiet-poet').points_balance, 0);
  const row = growth.rows().find(r => r.agent_id === 'quiet-poet');
  assert.equal(row.credentialed, 1);
  assert.ok(row.first_connection_at);
  assert.equal(row.status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM welcome_rewards WHERE agent_id=?').get('quiet-poet').n, 0);
  delete require.cache[require.resolve('../src/welcome-points')];
  require('../src/welcome-points');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM welcome_rewards WHERE agent_id=?').get('quiet-poet').n, 0);
});

test('first valid viewer chat earns 100 once in house or external rooms, independently of growth review', () => {
  for (const [hostId, visitorId, internal] of [['house-stage', 'first-poet', true], ['outside-stage', 'second-poet', false]]) {
    const { broadcastId } = room(hostId, internal);
    const ws = register(visitorId);
    const result = chat(ws, broadcastId, 'Hello from ' + visitorId);
    assert.deepEqual(result.welcomeReward, { amount: 100, reason: 'first_public_chat' });
    assert.equal(repo.getAgent(visitorId).points_balance, 100);
    assert.equal(ws.messages.filter(m => m.type === 'points_granted').length, 1);
    assert.equal(growth.rows().find(r => r.agent_id === visitorId).status, 'pending');
    chat(ws, broadcastId, 'A second thought from ' + visitorId);
    const reconnected = register(visitorId);
    chat(reconnected, broadcastId, 'Back again, ' + visitorId);
    assert.equal(repo.getAgent(visitorId).points_balance, 100);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM welcome_rewards WHERE agent_id=?').get(visitorId).n, 1);
  }
});

test('invalid, unjoined, internal, uncredentialed, own-room and host messages do not earn the reward', () => {
  const { host, broadcastId } = room('eligibility-stage');
  const ws = register('careful-poet');
  send(ws, 'stream_chat', { broadcastId, text: 'Not joined yet' });
  chat(ws, broadcastId, '   ');
  send(ws, 'stream_chat', { broadcastId: 'bc_missing', text: 'Missing room' });
  const internal = register('house-listener', { internal: true });
  const uncredentialed = register('anonymous-listener', { secret: null });
  chat(internal, broadcastId, 'Internal hello');
  chat(uncredentialed, broadcastId, 'Unprotected hello');
  chat(host, broadcastId, 'Chatting in my own room');
  send(host, 'stream_text', { broadcastId, text: 'Opening the show', audioExpected: false });
  for (const id of ['careful-poet', 'house-listener', 'anonymous-listener', 'eligibility-stage']) {
    assert.equal(repo.getAgent(id).points_balance, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM welcome_rewards WHERE agent_id=?').get(id).n, 0);
  }
});

test('the existing 10-point later-day login bonus remains once daily, including quiet observers', (t) => {
  const base = Date.now();
  register('daily-observer');
  t.mock.method(Date, 'now', () => base + 86400000);
  assert.equal(repo.grantLoginBonus('daily-observer').granted, 10);
  assert.equal(repo.grantLoginBonus('daily-observer').granted, 0);
  assert.equal(repo.getAgent('daily-observer').points_balance, 10);
});

test('MCP publish retries preserve one welcome credit and those points work in the existing donation economy', () => {
  const { broadcastId } = room('mcp-welcome-stage');
  repo.registerAgent({ agentId: 'mcp-welcome-poet', name: 'MCP poet' }, 'persistent-mcp-secret');
  const identity = { agentId: 'mcp-welcome-poet', grantId: 'welcome-grant', scope: 'pulsar:read pulsar:write' };
  const actions = require('../src/agent-actions');
  const execute = (name, args) => actions.execute(name, args, identity, '203.0.113.25');
  execute('begin_visit', { requestId: 'welcome-begin', minutes: 1 });
  execute('join_room', { requestId: 'welcome-join', broadcastId });
  const args = { requestId: 'welcome-publish', broadcastId, text: 'One greeting, one receipt.' };
  const first = execute('publish_message', args);
  const retry = execute('publish_message', args);
  assert.equal(first.welcomeReward.amount, 100);
  assert.equal(retry.messageId, first.messageId);
  assert.equal(retry.replayed, true);
  assert.equal(repo.getAgent(identity.agentId).points_balance, 100);
  assert.equal(repo.getAgent(identity.agentId).points_received, 0);
  assert.equal(repo.donate(identity.agentId, 'mcp-welcome-stage', 5, 'A good encounter', broadcastId).ok, true);
  assert.equal(repo.getAgent(identity.agentId).points_balance, 95);
  assert.equal(repo.getAgent('mcp-welcome-stage').points_received, 5);
  execute('end_visit', { requestId: 'welcome-end' });
});

test('committing a message and its point credit is atomic on a reward failure', () => {
  const { broadcastId } = room('atomic-stage');
  register('atomic-poet');
  db.exec("CREATE TRIGGER reject_reward BEFORE INSERT ON welcome_rewards WHEN NEW.agent_id='atomic-poet' BEGIN SELECT RAISE(ABORT,'reward unavailable'); END");
  assert.throws(() => repo.addMessage({ broadcastId, agentId: 'atomic-poet', role: 'viewer', text: 'Atomic hello', ts: Date.now() }), /reward unavailable/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE agent_id=?').get('atomic-poet').n, 0);
  assert.equal(repo.getAgent('atomic-poet').points_balance, 0);
  db.exec('DROP TRIGGER reject_reward');
});

test('concurrent database connections can credit an eligible first message only once', async () => {
  register('concurrent-poet');
  const messageId = Number(rawMessage.run('bc_1111', 'concurrent-poet', 'viewer', 'A concurrent hello', Date.now()).lastInsertRowid);
  const run = () => new Promise((resolve, reject) => {
    const w = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      const reward=require(workerData.module).grantForMessage(workerData.messageId);
      require(workerData.database).close(); parentPort.postMessage(reward);`, {
      eval: true, workerData: { module: require.resolve('../src/welcome-points'), database: require.resolve('../src/db'), messageId },
    });
    w.once('message', resolve); w.once('error', reject); w.once('exit', code => { if (code) reject(new Error('worker exit ' + code)); });
  });
  const results = await Promise.all([run(), run(), run()]);
  assert.equal(results.reduce((n, r) => n + r.granted, 0), 100);
  assert.equal(repo.getAgent('concurrent-poet').points_balance, 100);
});
