// Synthetic localhost evidence only. Starts its own server and temporary DB.
// Never connects to Pulsar production or imports a production identity.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createRequire } = require('node:module');

const [serverArg, commit, outputArg] = process.argv.slice(2);
if (!serverArg || !/^[a-f0-9]{40}$/.test(commit || '') || !outputArg) {
  throw new Error('Usage: node capture.cjs SERVER_DIRECTORY SOURCE_COMMIT OUTPUT_JSON');
}
const serverDir = path.resolve(serverArg);
const output = path.resolve(outputArg);
const requireServer = createRequire(path.join(serverDir, 'package.json'));
const WebSocket = requireServer('ws');
const Database = requireServer('better-sqlite3');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-context-evidence-'));
const sourceHash = name => crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(serverDir, 'src', name))).digest('hex');
const cases = [
  { name: 'no-audio-expected', ttsProvider: 'fixture-audio', audioExpected: false, pending: false },
  { name: 'browser-provider', ttsProvider: 'browser', audioExpected: true, pending: false },
  { name: 'no-provider', audioExpected: true, pending: false },
  { name: 'pending-audio-control', ttsProvider: 'fixture-audio', audioExpected: true, pending: true },
];
const clients = [];
let child;
let db;

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames = [];
  ws.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
  await once(ws, 'open');
  const client = {
    ws, frames,
    send(type, payload) { ws.send(JSON.stringify({ type, payload })); },
    async waitFor(predicate) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const found = frames.find(predicate);
        if (found) return found;
        const error = frames.find(f => f.type === 'error' || f.type === 'warning');
        if (error) throw new Error(JSON.stringify(error));
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Timed out waiting for a localhost fixture frame');
    },
  };
  clients.push(client);
  return client;
}

async function main() {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  child = spawn(process.execPath, [path.join(serverDir, 'src/index.js')], {
    cwd: serverDir,
    env: {
      PATH: process.env.PATH,
      PORT: String(port), PULSAR_HOST: '127.0.0.1',
      PULSAR_DATA_DIR: temp,
      PULSAR_V1_POINTS: path.join(temp, 'no-production-import.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local server startup timed out')), 10000);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Local server exited ${code}`)));
    let log = '';
    child.stdout.on('data', data => {
      log += data;
      if (log.includes('[pulsar-v2] listening')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', () => {});
  });
  db = new Database(path.join(temp, 'pulsar.db'), { readonly: true });
  const rows = broadcastId => db.prepare(
    'SELECT id, broadcast_id, agent_id, role, text, turn, ts FROM messages WHERE broadcast_id=? ORDER BY id'
  ).all(broadcastId);
  const result = {
    schemaVersion: 1, synthetic: true, transport: 'Real WebSocket frames over localhost TCP',
    productionConnection: false, externalParticipant: false,
    captureStartedAt: new Date().toISOString(), sourceCommit: commit,
    protocolSha256: sourceHash('pulsar.js'), bootstrapSha256: sourceHash('index.js'),
    captureSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    sourceCommitNote: 'Caller-supplied git revision; compare protocol/bootstrap hashes with that revision.',
    exclusions: ['Registration frames and session tokens', 'Broadcast stream keys'],
    cases: [],
  };
  for (const fixture of cases) {
    const host = await connect(port);
    const viewer = await connect(port);
    const hostId = `fixture-context-host-${fixture.name}`;
    const viewerId = `fixture-context-viewer-${fixture.name}`;
    const registration = { agentId: hostId, name: hostId, participationMode: 'explicit' };
    if (fixture.ttsProvider) registration.ttsProvider = fixture.ttsProvider;
    host.send('register', registration);
    viewer.send('register', { agentId: viewerId, name: viewerId, participationMode: 'explicit' });
    await host.waitFor(f => f.type === 'registered');
    await viewer.waitFor(f => f.type === 'registered');
    host.send('broadcast_start', { title: `LOCAL SYNTHETIC FIXTURE: ${fixture.name}` });
    const { broadcastId } = (await host.waitFor(f => f.type === 'broadcast_approved')).payload;
    viewer.send('join_room', { broadcastId });
    await viewer.waitFor(f => f.type === 'room_joined');
    const audienceCommand = { type: 'stream_chat', payload: { broadcastId, text: `Synthetic preceding audience line: ${fixture.name}.` } };
    viewer.send(audienceCommand.type, audienceCommand.payload);
    await viewer.waitFor(f => f.type === 'chat_ack');
    const hostText = `Synthetic host question: ${fixture.name}. This is not an external participant.`;
    const hostCommand = { type: 'stream_text', payload: { broadcastId, text: hostText, turn: 1, audioExpected: fixture.audioExpected } };
    host.send(hostCommand.type, hostCommand.payload);
    await viewer.waitFor(f => f.type === 'viewer_context' && f.payload.yourTurn);
    const sqlBeforeEnd = rows(broadcastId);
    const beforeEndFrames = viewer.frames.filter(f => f.type === 'viewer_context' || f.type === 'live_update');
    host.send('broadcast_end', { broadcastId }); // Flushes pending preview; no audio bytes are sent.
    await viewer.waitFor(f => f.type === 'broadcast_ended');
    result.cases.push({
      ...fixture, hostId, viewerId, broadcastId, hostText,
      inputs: { hostRegistrationWithoutCredentials: registration, audienceCommand, hostCommand, flush: 'broadcast_end' },
      beforeEnd: { viewerFrames: beforeEndFrames, sqliteRows: sqlBeforeEnd },
      afterEnd: { viewerFrames: viewer.frames.filter(f => f.type === 'viewer_context' || f.type === 'live_update'), sqliteRows: rows(broadcastId) },
    });
    host.ws.close(); viewer.ws.close();
    await Promise.all([once(host.ws, 'close'), once(viewer.ws, 'close')]);
  }
  result.captureFinishedAt = new Date().toISOString();
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: path.basename(output), cases: result.cases.length, synthetic: true }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  for (const c of clients) c.ws.terminate();
  if (db) db.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
  fs.rmSync(temp, { recursive: true, force: true });
});
