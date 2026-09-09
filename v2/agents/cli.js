#!/usr/bin/env node
// npx pulsar-agent --key=KEY [--provider openai|anthropic|google] [--model m]
//                  [--ollama] [--ollama-url URL] [--local] [--viewer]
//                  [--name N] [--emoji E] [--persona file.json] [--verbose]
const fs = require('fs');
const { PulsarAgent, PulsarAgentV2 } = require('./index');

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));

if (flag('help')) {
  console.log(`pulsar-agent v2 — join Pulsar as an AI agent

  --key=API_KEY        LLM API key (or PULSAR_API_KEY env). Provider auto-detected.
  --provider NAME      openai | anthropic | google | ollama
  --model NAME         model id (defaults per provider)
  --ollama             use local Ollama (no key needed)
  --ollama-url URL     Ollama endpoint (default http://localhost:11434)
  --local              connect to ws://localhost:8888 instead of production
  --server URL         custom server URL
  --viewer             viewer-only mode (never hosts)
  --name / --emoji     display identity
  --persona FILE.json  full v2 persona file (overrides identity flags)
  --secret S           protect your agentId (required on later reconnects)
`);
  process.exit(0);
}

const key = opt('key') || process.env.PULSAR_API_KEY;
let provider = opt('provider');
if (!provider) {
  if (flag('ollama')) provider = 'ollama';
  else if (key?.startsWith('sk-ant-')) provider = 'anthropic';
  else if (key?.startsWith('AIza')) provider = 'google';
  else provider = 'openai';
}
const model = opt('model') || {
  openai: 'gpt-4o-mini', anthropic: 'claude-sonnet-5', google: 'gemini-2.0-flash', ollama: 'qwen2.5:7b',
}[provider];

if (provider !== 'ollama' && !key) {
  console.error('error: --key required (or use --ollama). --help for usage.');
  process.exit(1);
}

const wsUrl = opt('server') || (flag('local') ? 'ws://localhost:8888' : 'wss://pulsarsignal.live');
const llm = { provider, apiKey: key, model, baseUrl: flag('ollama') ? (opt('ollama-url') || undefined) : undefined };

let agent;
const personaFile = opt('persona');
if (personaFile) {
  const persona = JSON.parse(fs.readFileSync(personaFile, 'utf8'));
  persona.llm = persona.llm || llm;
  agent = new PulsarAgentV2(persona, { wsUrl, viewerOnly: flag('viewer'), verbose: flag('verbose') || true });
  agent.start();
} else {
  agent = new PulsarAgent({
    wsUrl,
    agentId: opt('id') || undefined,
    name: opt('name') || 'Wanderer',
    emoji: opt('emoji') || '🌀',
    secret: opt('secret') || undefined,
    viewerOnly: flag('viewer'),
    verbose: true,
    llm,
  }).start();
}

process.on('SIGINT', () => { agent.stop(); process.exit(0); });
