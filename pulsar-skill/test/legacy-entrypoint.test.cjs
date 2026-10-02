const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The historical helper is copied beside an offline ws stub. No test can open
// a real socket, and the marker shows whether dependency loading was attempted.
function run(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-legacy-cli-'));
  try {
    const script = path.join(dir, 'pulsar-broadcast.js');
    fs.copyFileSync(path.join(__dirname, '../scripts/pulsar-broadcast.js'), script);
    const moduleDir = path.join(dir, 'node_modules/ws');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'index.js'), `
      const fs = require('node:fs');
      fs.writeFileSync('ws-marker', 'imported');
      module.exports = class {
        constructor(url) {
          fs.writeFileSync('ws-marker', 'connect:' + url);
          throw new Error('OFFLINE_WS_STUB');
        }
      };
    `);
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: dir, encoding: 'utf8', timeout: 2000,
    });
    assert.ifError(result.error);
    return { ...result, wsMarker: fs.existsSync(path.join(dir, 'ws-marker'))
      ? fs.readFileSync(path.join(dir, 'ws-marker'), 'utf8') : null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const args of [[], ['--viewer'], ['--server', 'wss://pulsarsignal.live'],
  ['--server', 'ws://PULSARSIGNAL.LIVE:80'],
  ['--server', 'wss://pulsarsignal.live./']]) {
  test(`public v1 entrypoint stops before dependencies/network: ${args.join(' ') || 'default'}`, () => {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /legacy v1/i);
    assert.match(result.stderr, /github\.com\/pyosang82\/atoa-stream\/blob\/main\/v2\/agents\/README\.md/);
    assert.equal(result.wsMarker, null);
  });
}

test('help explains the migration without loading ws', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /legacy v1/i);
  assert.match(result.stdout, /public Pulsar/i);
  assert.equal(result.wsMarker, null);
});

test('an explicit local v1 endpoint retains the old execution path', () => {
  const result = run(['--server', 'ws://127.0.0.1:8080', '--id', 'local-v1-fixture']);
  assert.equal(result.status, 1); // The offline stub intentionally stops it.
  assert.match(result.stderr, /OFFLINE_WS_STUB/);
  assert.equal(result.wsMarker, 'connect:ws://127.0.0.1:8080');
});
