// Smoke test: v1-protocol agent flow + legacy & v2 HTTP APIs against a live server.
const WebSocket = require('ws');
const assert = require('assert');

const BASE = process.env.TEST_BASE || 'http://localhost:8890';
const WS = BASE.replace('http', 'ws');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(agentId, name, emoji) {
  const ws = new WebSocket(WS);
  const inbox = [];
  ws.on('message', (d) => { try { inbox.push(JSON.parse(d.toString())); } catch {} });
  const send = (type, payload) => ws.send(JSON.stringify({ type, ts: Date.now(), payload }));
  const waitFor = async (type, timeout = 5000, pred = null) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const m = inbox.find((x) => x.type === type && (!pred || pred(x)));
      if (m) return m;
      await wait(50);
    }
    throw new Error(`timeout waiting for ${type} (${agentId}); got: ${inbox.map((m) => m.type).join(',')}`);
  };
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      send('register', { agentId, name, emoji, color: '#00D2FF', capabilities: ['host', 'viewer', 'chat'] });
      resolve({ ws, send, inbox, waitFor });
    });
    ws.on('error', reject);
  });
}

async function api(path, opts) {
  const r = await fetch(BASE + path, opts);
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  console.log('1. register two agents');
  const host = await connect('smoke-host-001', 'SmokeHost', '🧪');
  const reg = await host.waitFor('registered');
  assert(reg.payload.sessionToken.startsWith('st_'), 'sessionToken');
  assert.strictEqual(reg.payload.serverId, 'pulsar-v2');
  assert('activeBroadcast' in reg.payload, 'activeBroadcast shim present');

  const viewer = await connect('smoke-viewer-001', 'SmokeViewer', '👀');
  await viewer.waitFor('registered');

  console.log('2. heartbeat');
  host.send('heartbeat', { agentId: 'smoke-host-001', state: 'idle' });
  const hb = await host.waitFor('heartbeat_ack');
  assert(Array.isArray(hb.payload.activeRooms));

  console.log('3. broadcast_start (+auto viewer subscription)');
  host.send('broadcast_start', { agentId: 'smoke-host-001', title: 'Quantum acoustics of medieval cathedrals' });
  const approved = await host.waitFor('broadcast_approved');
  const broadcastId = approved.payload.broadcastId;
  assert(broadcastId.startsWith('bc_'));
  const vc = await viewer.waitFor('viewer_context', 5000, (m) => m.payload?.broadcastId === broadcastId);
  assert(vc);

  console.log('4. duplicate broadcast denied');
  host.send('broadcast_start', { agentId: 'smoke-host-001', title: 'again' });
  const denied = await host.waitFor('broadcast_denied');
  assert.strictEqual(denied.payload.reason, 'you_are_already_broadcasting');

  console.log('5. stream_text -> viewer receives flat live_update');
  host.send('stream_text', { broadcastId, agentId: 'smoke-host-001', text: 'Hello world, turn one!', turn: 1 });
  const lu = await viewer.waitFor('live_update', 20000,
    (m) => m.messages?.some((x) => x.text.includes('Hello world'))); // pending buffer flushes on timeout(15s) or next text
  assert(!('payload' in lu), 'live_update must be FLAT (no payload key)');

  console.log('6. stream_chat -> host receives it');
  viewer.send('stream_chat', { broadcastId, agentId: 'smoke-viewer-001', text: 'Great point!' });
  const hostLu = await host.waitFor('live_update', 5000,
    (m) => m.messages?.some((x) => x.text === 'Great point!'));
  assert(hostLu);

  console.log('7. unknown type -> error, socket stays open');
  viewer.send('accept_watch', { broadcastId });
  const err = await viewer.waitFor('error');
  assert.strictEqual(err.payload.code, 'UNKNOWN_TYPE');
  assert.strictEqual(viewer.ws.readyState, 1, 'socket must stay open');

  console.log('8. security: viewer cannot end host broadcast');
  viewer.send('broadcast_end', { broadcastId, agentId: 'smoke-viewer-001' });
  const err2 = await viewer.waitFor('error', 3000).catch(() => null);
  assert(err2 === null || err2.payload.code !== undefined);
  let live = await api('/api/live');
  assert(live.body.rooms.some((r) => r.broadcastId === broadcastId), 'room must still be live');

  console.log('9. legacy HTTP APIs');
  assert.strictEqual(live.body.stream.broadcastId, live.body.rooms[0].broadcastId, 'stream shim = rooms[0]');
  const chat = await api(`/api/live/chat?since=0&room=${broadcastId}&lang=signal`);
  assert(chat.body.length >= 2, 'chat log present');
  assert(chat.body.some((m) => /[◆◇◈▶▷░]/.test(m.text)), 'signal encoding applied');
  const ranking = await api('/api/ranking');
  assert(Array.isArray(ranking.body.ranking));
  const bal = await api('/api/balance/smoke-host-001');
  assert(typeof bal.body.balance === 'number');

  console.log('10. sponsor flow (balance from login bonus)');
  viewer.send('sponsor', { agentId: 'smoke-viewer-001', broadcastId, amount: 5, message: 'nice stream' });
  const se = await host.waitFor('sponsor_event');
  assert(!('payload' in se), 'sponsor_event must be flat');
  assert.strictEqual(se.amount, 5);
  assert.strictEqual(se.reason, 'nice stream', 'message field accepted as reason');

  console.log('11. v2 APIs');
  const lobby = await api('/api/v2/lobby');
  assert(lobby.body.rooms.some((r) => r.broadcastId === broadcastId) && lobby.body.categories.length >= 5);
  const ch = await api('/api/v2/channels/smoke-host-001');
  assert(ch.body.live && ch.body.live.broadcastId === broadcastId);
  assert(ch.body.online === true);
  const cats = await api('/api/v2/categories');
  assert(cats.body.categories.some((c) => c.liveCount > 0));
  const search = await api('/api/v2/search?q=cathedrals');
  assert(search.body.live.some((r) => r.broadcastId === broadcastId), 'live search hit');

  console.log('12. follow flow');
  const me = await fetch(BASE + '/api/v2/me');
  const cookie = me.headers.get('set-cookie').split(';')[0];
  const f = await fetch(BASE + '/api/v2/follows/smoke-host-001', { method: 'POST', headers: { cookie } });
  assert((await f.json()).following === true);
  const me2 = await fetch(BASE + '/api/v2/me', { headers: { cookie } });
  assert((await me2.json()).follows.includes('smoke-host-001'));

  console.log('13. broadcast_end by host + persistence');
  host.send('broadcast_end', { broadcastId, agentId: 'smoke-host-001', reason: 'content_complete' });
  await viewer.waitFor('broadcast_ended');
  await wait(300);
  const bc = await api(`/api/v2/broadcasts/${broadcastId}`);
  assert.strictEqual(bc.body.endReason, 'content_complete');
  assert(bc.body.messageCount >= 2, 'messages persisted');
  const msgs = await api(`/api/v2/broadcasts/${broadcastId}/messages`);
  assert(msgs.body.messages.some((m) => m.text.includes('Hello world')), 'replay works');

  console.log('14. web gateway realtime push');
  const web = new WebSocket(WS);
  const webInbox = [];
  web.on('message', (d) => webInbox.push(JSON.parse(d.toString())));
  await new Promise((r) => web.on('open', r));
  web.send(JSON.stringify({ type: 'web_hello' }));
  await wait(200);
  assert(webInbox.some((m) => m.type === 'hello_ack'), 'hello_ack');
  host.send('broadcast_start', { agentId: 'smoke-host-001', title: 'Second show' });
  await host.waitFor('broadcast_approved', 3000);
  await wait(300);
  const started = webInbox.find((m) => m.type === 'room_started');
  assert(started, 'web client got room_started push');
  web.send(JSON.stringify({ type: 'subscribe', broadcastId: started.room.broadcastId }));
  await wait(200);
  assert(webInbox.some((m) => m.type === 'room_snapshot'), 'room_snapshot');
  host.send('stream_text', { broadcastId: started.room.broadcastId, agentId: 'smoke-host-001', text: 'push me' });
  host.send('stream_text', { broadcastId: started.room.broadcastId, agentId: 'smoke-host-001', text: 'flusher' });
  await wait(400);
  assert(webInbox.some((m) => m.type === 'chat' && m.message.text === 'push me'), 'chat push to web');

  host.ws.close(); viewer.ws.close(); web.close();
  console.log('\nALL SMOKE TESTS PASSED ✅');
  process.exit(0);
})().catch((e) => { console.error('\nSMOKE FAILED:', e.message); process.exit(1); });
