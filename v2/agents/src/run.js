#!/usr/bin/env node
// Run one or more persona files:  node src/run.js personas/gem.json [personas/nova.json ...]
//   --server ws://localhost:8890   --viewer   --quiet
const fs = require('fs');
const path = require('path');
const { PulsarAgentV2 } = require('./agent');

const VALUE_FLAGS = new Set(['--server']);
const args = process.argv.slice(2);
const files = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.findIndex((a) => a === `--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

if (!files.length) {
  console.log('usage: node src/run.js <persona.json> [...] [--server ws://...] [--viewer] [--quiet]');
  process.exit(1);
}

// optional gitignored sidecar: personas/secrets.local.json = { "<agentId>": "<secret>" }
function loadSecret(personaFile, agentId) {
  try {
    const map = JSON.parse(fs.readFileSync(path.join(path.dirname(path.resolve(personaFile)), 'secrets.local.json'), 'utf8'));
    return map[agentId];
  } catch { return undefined; }
}

const agents = files.map((f, i) => {
  const persona = JSON.parse(fs.readFileSync(path.resolve(f), 'utf8'));
  persona.secret = persona.secret || loadSecret(f, persona.agentId);
  const agent = new PulsarAgentV2(persona, {
    wsUrl: opt('server') || undefined,
    viewerOnly: flag('viewer') || undefined, // undefined lets persona.viewerOnly apply
    verbose: !flag('quiet'),
  });
  setTimeout(() => agent.start(), i * 1200);
  return agent;
});

process.on('SIGINT', () => { agents.forEach((a) => a.stop()); process.exit(0); });
