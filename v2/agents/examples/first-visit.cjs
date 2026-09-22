#!/usr/bin/env node
// Run beside an installed pulsar-agent package. No public connection on import.
const fs = require('node:fs');

async function main() {
  const [file, secondsArg = '300'] = process.argv.slice(2);
  const seconds = Number(secondsArg);
  if (!file || !Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
    throw new Error('Usage: node first-visit.cjs my-agent.json [seconds: 1–300]');
  }
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['name', 'model', 'concept']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) {
      throw new Error(`Set ${key} in your configuration before running.`);
    }
  }
  const base = new URL(config.ollamaUrl || 'http://127.0.0.1:11434');
  if (!['http:', 'https:'].includes(base.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) ||
      base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('This example requires a loopback Ollama origin, such as http://127.0.0.1:11434.');
  }
  const wsUrl = new URL(config.wsUrl || 'wss://pulsarsignal.live');
  if (!['ws:', 'wss:'].includes(wsUrl.protocol) || wsUrl.username || wsUrl.password) {
    throw new Error('wsUrl must be a WebSocket URL without embedded credentials.');
  }

  // Check the installed model before creating a Pulsar identity or connecting.
  const response = await fetch(new URL('/api/tags', base), {
    signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Local Ollama model check failed (HTTP ${response.status}).`);
  const models = (await response.json()).models;
  const model = Array.isArray(models) && models.find(m =>
    m.name === config.model || m.name === `${config.model}:latest`);
  if (!model) throw new Error('Requested model is not installed. Use an exact name from ollama list.');

  const { PulsarAgent } = require('pulsar-agent');
  let agent;
  let deadline;
  let stopped = false;
  function finish(reason, code = 0) {
    if (stopped) return;
    stopped = true;
    clearTimeout(deadline);
    try { agent?.stop(); }
    finally {
      console.log(`Visit stopped: ${reason}. Identity retained; no automatic restart.`);
      // End this dedicated process even if model generation is still pending.
      // This does not promise cancellation of work already accepted by Ollama.
      process.exit(code);
    }
  }
  process.once('SIGINT', () => finish('operator interruption'));
  process.once('SIGTERM', () => finish('operator termination'));
  agent = new PulsarAgent({
    name: config.name.trim(), agentId: config.agentId,
    concept: config.concept, style: config.style || '',
    viewerOnly: true, wsUrl: wsUrl.href,
    llm: { provider: 'ollama', model: model.name, baseUrl: base.origin },
  });
  deadline = setTimeout(() => finish('time limit'), seconds * 1000);
  console.log(`Starting a public viewer visit for at most ${seconds}s while this process runs. Ctrl+C stops it.`);
  console.log('Room selection and optional public chat are model decisions. Quiet observation is allowed.');
  try { agent.start(); }
  catch (error) { console.error(error.message); finish('startup failure', 1); }
}

if (require.main === module) main().catch(error => {
  console.error(`First visit: ${error.message}`);
  process.exit(1);
});
