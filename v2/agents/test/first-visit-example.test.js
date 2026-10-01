const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-first-visit-'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  const sdk = process.env.PULSAR_EXAMPLE_TEST_SDK || path.resolve(__dirname, '..');
  fs.symlinkSync(sdk, path.join(dir, 'node_modules', 'pulsar-agent'), 'dir');
  fs.copyFileSync(path.join(__dirname, '../examples/first-visit.cjs'), path.join(dir, 'first-visit.cjs'));
  const calls = { tags: 0, chats: 0, registrations: [], closed: 0, publicChats: [] };
  const pendingReplies = [];
  if (options.burst) fs.writeFileSync(path.join(dir, 'deterministic.cjs'), 'Math.random = () => 0;');
  let onChat;
  const chatStarted = new Promise(resolve => { onChat = resolve; });
  const model = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      calls.tags++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'fixture-model:latest' }] }));
    } else if (req.url === '/api/chat') {
      calls.chats++;
      onChat();
      // Release three concurrent generations together to exercise the send boundary.
      if (options.burst) {
        pendingReplies.push(res);
        if (pendingReplies.length === 3) {
          for (const reply of pendingReplies.splice(0)) {
            reply.setHeader('Content-Type', 'application/json');
            reply.end(JSON.stringify({ message: { content: 'A local test observation.' } }));
          }
        }
      } // Otherwise deliberately leave generation pending until the client exits.
    } else { res.writeHead(404).end(); }
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const world = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(world, 'listening');
  world.on('connection', socket => {
    socket.on('close', () => calls.closed++);
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type === 'stream_chat') {
        calls.publicChats.push(message.payload);
        if (options.reconnect && calls.publicChats.length === 2) socket.close();
      }
      if (message.type !== 'register') return;
      calls.registrations.push(message.payload);
      socket.send(JSON.stringify({ type: 'registered', payload: {
        agentId: message.payload.agentId, features: ['explicit_participation'],
        activeRooms: [{ broadcastId: 'fixture-room', agentId: 'fixture-host', title: 'Local test' }],
      } }));
      if (options.burst) {
        for (const broadcastId of ['bc_aa', 'bc_bb', 'bc_cc']) {
          socket.send(JSON.stringify({ type: 'room_joined', payload: {
            broadcastId, room: { hostName: 'Local host', title: 'Local test' },
          } }));
          socket.send(JSON.stringify({ type: 'viewer_context', payload: {
            broadcastId, yourTurn: true, host: { name: 'Local host' },
            title: 'Local test', recentMessages: [{ role: 'host', text: 'What do you notice?' }],
          } }));
        }
      }
    });
  });
  const baseConfig = {
    name: 'LocalTestOnly', concept: 'Local test persona', model: 'fixture-model:latest',
    ollamaUrl: `http://127.0.0.1:${model.address().port}`,
    wsUrl: `ws://127.0.0.1:${world.address().port}`,
  };
  const children = new Set();
  function run(seconds = 1, patch = {}) {
    const config = path.join(dir, 'my-agent.json');
    fs.writeFileSync(config, JSON.stringify({ ...baseConfig, ...patch }));
    const child = spawn(process.execPath, [...(options.burst ? ['--require', './deterministic.cjs'] : []), 'first-visit.cjs', config, String(seconds)], {
      cwd: dir, env: { ...process.env, PULSAR_HOME: path.join(dir, 'identity') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
    const done = once(child, 'close').then(([code, signal]) => {
      clearTimeout(timeout); children.delete(child); return { code, signal, output };
    });
    return { child, done };
  }
  t.after(async () => {
    for (const child of children) child.kill('SIGKILL');
    for (const socket of world.clients) socket.terminate();
    await new Promise(resolve => world.close(resolve));
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, calls, run, chatStarted };
}

test('missing model does not create an identity or connect publicly', async t => {
  const f = await fixture(t);
  const result = await f.run(1, { model: 'not-installed' }).done;
  assert.equal(result.code, 1);
  assert.match(result.output, /not installed/);
  assert.equal(f.calls.registrations.length, 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'identity')), false);
});

test('invalid duration, message limit or model endpoint stops before any network setup', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(301).done).code, 1);
  for (const maxMessages of [-1, 3, 0.5, '2', null]) {
    assert.equal((await f.run(1, { maxMessages }).done).code, 1);
  }
  assert.equal((await f.run(1, { ollamaUrl: 'https://example.invalid' }).done).code, 1);
  assert.equal(f.calls.tags, 0);
  assert.equal(f.calls.registrations.length, 0);
});

test('deadline exits during pending generation and the next run reuses viewer credentials', async t => {
  const f = await fixture(t);
  const first = await f.run(2).done;
  assert.equal(first.code, 0);
  assert.equal(first.signal, null);
  assert.match(first.output, /Visit stopped: time limit/);
  assert.ok(f.calls.chats > 0, 'generation was pending at the deadline');
  const second = await f.run(1).done;
  assert.equal(second.code, 0);
  assert.equal(f.calls.registrations.length, 2);
  for (const registration of f.calls.registrations) {
    assert.deepEqual(registration.capabilities, ['viewer', 'chat']);
  }
  const [a, b] = f.calls.registrations;
  assert.ok(a.agentId === b.agentId, 'same stored agent identity');
  assert.ok(a.secret && a.secret === b.secret, 'same private credential; never printed');
  assert.equal(f.calls.closed, 2);
});

test('operator interruption exits without waiting for model generation', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const run = f.run(300);
  await f.chatStarted;
  run.child.kill('SIGINT');
  const result = await run.done;
  assert.equal(result.code, 0);
  assert.match(result.output, /operator interruption/);
  assert.equal(f.calls.registrations.length, 1);
});


test('default two-message ceiling survives concurrent generations and reconnect', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { burst: true, reconnect: true });
  const result = await f.run(5).done;
  assert.equal(result.code, 0);
  assert.equal(f.calls.publicChats.length, 2, 'third queued generation must not send');
  assert.ok(f.calls.registrations.length >= 2, 'reconnection exercised the same visit budget');
  assert.equal(f.calls.chats, 3, 'no more chat generation after reaching the ceiling');
  assert.match(result.output, /message limit reached.*quietly/i);
});

test('one-message and observation-only limits are enforced without scripted speech', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { burst: true });
  assert.equal((await f.run(2, { maxMessages: 1 }).done).code, 0);
  assert.equal(f.calls.publicChats.length, 1);
  assert.equal(f.calls.chats, 3, 'concurrent drafts do not bypass one-message ceiling');
  assert.equal((await f.run(2, { maxMessages: 0 }).done).code, 0);
  assert.equal(f.calls.publicChats.length, 1, 'observation adds no public messages');
  assert.equal(f.calls.chats, 3, 'observation does not generate viewer replies');
});
