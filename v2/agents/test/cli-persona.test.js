const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

// Execute the real CLI parser/preflight in a child process. Replace only runtime
// construction/start so no identity, memory, WebSocket or model request is made.
function run(t, persona, args = [], apiKey = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-cli-persona-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'capture.cjs');
  fs.writeFileSync(preload, `
    const Module = require('node:module');
    const original = Module._load;
    const sdk = ${JSON.stringify(path.join(root, 'index.js'))};
    const { LLMEngine } = require(${JSON.stringify(path.join(root, 'src/llm.js'))});
    class Agent {
      constructor(config) { this.config = config; }
      start() {
        const e = new LLMEngine(this.config.llm);
        console.log(JSON.stringify({ name: this.config.name, llm: this.config.llm,
          effective: { provider: e.provider, model: e.model, apiKey: e.apiKey } }));
        return this;
      }
      stop() {}
    }
    Module._load = function(request, parent, isMain) {
      if (Module._resolveFilename(request, parent) === sdk)
        return { PulsarAgent: Agent, PulsarAgentV2: Agent };
      return original.call(this, request, parent, isMain);
    };
  `);
  const cliArgs = [...args];
  if (persona) {
    const file = path.join(dir, 'persona.json');
    fs.writeFileSync(file, JSON.stringify({ agentId: 'fixture-cli', name: 'Fixture', ...persona }));
    cliArgs.push('--persona', file);
  }
  const result = spawnSync(process.execPath, ['--require', preload, path.join(root, 'cli.js'), ...cliArgs], {
    env: { ...process.env, NODE_OPTIONS: '', PULSAR_API_KEY: apiKey, PULSAR_HOME: path.join(dir, 'unused') },
    encoding: 'utf8', timeout: 5000,
  });
  return { ...result, config: result.stdout ? JSON.parse(result.stdout) : null };
}

test('bundled Ollama persona reaches startup without an unrelated hosted-provider key', t => {
  const persona = JSON.parse(fs.readFileSync(path.join(root, 'examples/persona.example.json')));
  const r = run(t, persona);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.config.effective.provider, 'ollama');
  assert.equal(r.config.effective.model, persona.llm.model);
  assert.equal(r.config.effective.apiKey, null);
});

test('a hosted persona uses its own key and preserves provider-specific settings', t => {
  const llm = { provider: 'anthropic', model: 'fixture-model', apiKey: 'fixture-persona-key', temperature: 0.3 };
  const r = run(t, { llm });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.config.llm, llm);
  assert.equal(r.config.effective.apiKey, llm.apiKey);
});

test('the documented --persona plus --key path passes the key to the effective model', t => {
  const r = run(t, { llm: { provider: 'google', model: 'fixture-model' } }, ['--key=fixture-cli-key']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.config.effective, { provider: 'google', model: 'fixture-model', apiKey: 'fixture-cli-key' });
});

test('the environment key fills a hosted persona key without replacing its model', t => {
  const r = run(t, { llm: { provider: 'openai', model: 'fixture-model' } }, [], 'fixture-env-key');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.config.effective.apiKey, 'fixture-env-key');
  assert.equal(r.config.effective.model, 'fixture-model');
});

test('an existing persona key takes precedence over fallback CLI and environment keys', t => {
  const r = run(t, { llm: { provider: 'google', apiKey: 'fixture-persona-key' } }, ['--key=fixture-cli-key'], 'fixture-env-key');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.config.effective.apiKey, 'fixture-persona-key');
});

test('a hosted persona missing its key is rejected before startup even with --ollama', t => {
  const r = run(t, { llm: { provider: 'openai', model: 'fixture-model' } }, ['--ollama']);
  assert.equal(r.status, 1);
  assert.equal(r.config, null);
  assert.match(r.stderr, /key required/i);
});

test('standalone Ollama and default hosted-key requirements retain their behavior', t => {
  const local = run(t, null, ['--ollama', '--model', 'fixture-model']);
  assert.equal(local.status, 0, local.stderr);
  assert.equal(local.config.effective.provider, 'ollama');
  assert.equal(local.config.effective.model, 'fixture-model');
  const missing = run(t, null);
  assert.equal(missing.status, 1);
  assert.equal(missing.config, null);
});

test('a persona without llm inherits CLI model configuration', t => {
  const r = run(t, {}, ['--ollama', '--model', 'fixture-model']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.config.effective.provider, 'ollama');
  assert.equal(r.config.effective.model, 'fixture-model');
});
