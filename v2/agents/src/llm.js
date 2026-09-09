// LLM engine — multi-provider, exponential backoff, no fake health checks.
// Providers: ollama | openai | anthropic | google | scripted (deterministic, for tests)
class LLMEngine {
  constructor(cfg = {}) {
    this.provider = cfg.provider || 'ollama';
    this.model = cfg.model || 'qwen2.5:7b';
    this.apiKey = cfg.apiKey || null;
    this.baseUrl = cfg.baseUrl || null;
    this.temperature = cfg.temperature ?? 0.9;
    this.maxTokens = cfg.maxTokens ?? 220;
    this.timeoutMs = cfg.timeoutMs ?? 60_000;
    this.retries = cfg.retries ?? 3;
    this.think = cfg.think ?? false; // thinking models burn num_predict on thought otherwise
    this.scriptedLines = cfg.scriptedLines || null; // provider 'scripted'
    this._scriptIdx = 0;
  }

  async generate(system, history, opts = {}) {
    if (this.provider === 'scripted') {
      const lines = this.scriptedLines || ['(scripted response)'];
      return lines[this._scriptIdx++ % lines.length];
    }
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const text = await this._call(system, history, opts);
        return String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      } catch (e) {
        lastErr = e;
        const wait = Math.min(2000 * 2 ** attempt, 20_000);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  async _call(system, history, opts) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      switch (this.provider) {
        case 'ollama': return await this._ollama(system, history, opts, ctl.signal);
        case 'openai': return await this._openai(system, history, opts, ctl.signal);
        case 'anthropic': return await this._anthropic(system, history, opts, ctl.signal);
        case 'google': return await this._google(system, history, opts, ctl.signal);
        default: throw new Error(`unknown provider: ${this.provider}`);
      }
    } finally { clearTimeout(t); }
  }

  async _ollama(system, history, opts, signal) {
    const r = await fetch(`${this.baseUrl || 'http://localhost:11434'}/api/chat`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: system }, ...history],
        stream: false,
        think: this.think,
        options: { temperature: opts.temperature ?? this.temperature, num_predict: opts.maxTokens ?? this.maxTokens, num_ctx: 4096 },
      }),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    return (await r.json()).message?.content;
  }

  async _openai(system, history, opts, signal) {
    const r = await fetch(`${this.baseUrl || 'https://api.openai.com'}/v1/chat/completions`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: system }, ...history],
        temperature: opts.temperature ?? this.temperature,
        max_tokens: opts.maxTokens ?? this.maxTokens,
      }),
    });
    if (!r.ok) throw new Error(`openai ${r.status}`);
    return (await r.json()).choices?.[0]?.message?.content;
  }

  async _anthropic(system, history, opts, signal) {
    const r = await fetch(`${this.baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST', signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        system,
        messages: history,
        max_tokens: opts.maxTokens ?? this.maxTokens,
        temperature: opts.temperature ?? this.temperature,
      }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}`);
    return (await r.json()).content?.[0]?.text;
  }

  async _google(system, history, opts, signal) {
    // OpenAI-compatible shim keeps one code path for Gemini
    const r = await fetch(
      `${this.baseUrl || 'https://generativelanguage.googleapis.com'}/v1beta/openai/chat/completions`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'system', content: system }, ...history],
          temperature: opts.temperature ?? this.temperature,
          max_tokens: opts.maxTokens ?? this.maxTokens,
        }),
      });
    if (!r.ok) throw new Error(`google ${r.status}`);
    return (await r.json()).choices?.[0]?.message?.content;
  }
}

module.exports = { LLMEngine };
