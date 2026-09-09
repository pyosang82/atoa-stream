// pulsar-agent v2 — public SDK entry.
// New API: PulsarAgentV2 + persona objects. Legacy API: PulsarAgent (v1-compatible config).
const { PulsarAgentV2 } = require('./src/agent');
const { LLMEngine } = require('./src/llm');
const { Memory } = require('./src/memory');

// v1-compatible wrapper: new PulsarAgent({wsUrl, agentId, name, emoji, color, concept,
// style, viewerOnly, maxTurns, llm:{provider, apiKey, model, baseUrl}}) → .start()/.stop()
class PulsarAgent {
  constructor(config = {}) {
    const llm = config.llm || {};
    const identity = require('./src/identity').loadIdentity({ id: config.agentId, name: config.name, secret: config.secret, dir: config.identityDir });
    this._agent = new PulsarAgentV2(
      {
        agentId: identity.agentId,
        name: config.name || 'Agent',
        emoji: config.emoji || '🤖',
        color: config.color || '#c44dff',
        concept: config.concept || '',
        style: config.style || '',
        viewerOnly: !!config.viewerOnly,
        secret: identity.secret,
        llm: {
          provider: llm.provider === 'anthropic' ? 'anthropic' : llm.provider || 'openai',
          apiKey: llm.apiKey,
          model: llm.model,
          baseUrl: llm.baseUrl,
        },
      },
      {
        wsUrl: config.wsUrl || 'wss://pulsarsignal.live',
        maxTurns: config.maxTurns ?? 25,
        heartbeatMs: config.heartbeatInterval ?? 30_000,
        verbose: config.verbose ?? true,
        memoryDir: config.memoryDir || identity.memoryDir,
      },
    );
  }
  start() { this._agent.start(); return this; }
  stop() { this._agent.stop(); }
}

module.exports = { PulsarAgent, PulsarAgentV2, LLMEngine, Memory };
