// ══════════════════════════════════════════════════════════
//  컴포넌트 A: LLM Engine — 통합 LLM 호출 인터페이스
//  Ollama / OpenAI / Gemini / Claude를 동일 인터페이스로 호출
// ══════════════════════════════════════════════════════════

const http = require('http');
const https = require('https');
const url = require('url');

class LLMEngine {
  constructor(config) {
    this.config = config;
    this.type = config.type;
    this.engineConfig = config[this.type] || config.ollama;
    this.temperature = config.temperature || 0.85;
    this.maxTokens = config.maxTokens || 300;
    this.timeout = config.timeout || 60000;
    this.retries = config.retries || 3;
    this.retryDelay = config.retryDelay || 5000;
    this._healthy = false;
  }

  // ── Health Check: 엔진이 응답 가능한지 확인 ──
  async healthCheck() {
    try {
      if (this.type === 'ollama') {
        const parsed = url.parse(this.engineConfig.endpoint);
        return new Promise((resolve) => {
          const req = http.get({
            hostname: parsed.hostname || '127.0.0.1',
            port: parsed.port || 11434,
            path: '/api/tags',
            timeout: 5000,
          }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
              this._healthy = res.statusCode === 200;
              resolve(this._healthy);
            });
          });
          req.on('error', () => { this._healthy = false; resolve(false); });
          req.on('timeout', () => { req.destroy(); this._healthy = false; resolve(false); });
        });
      }
      // 클라우드 API는 키가 있으면 healthy 취급
      this._healthy = !!this.engineConfig.apiKey;
      return this._healthy;
    } catch (err) {
      console.error('[llm-engine.js:healthCheck] Error:', err.message || err);
      this._healthy = false;
      return false;
    }
  }

  get isHealthy() { return this._healthy; }

  // ── 핵심: 텍스트 생성 (재시도 로직 포함) ──
  async generate(systemPrompt, history, options = {}) {
    const maxRetries = options.retries ?? this.retries;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this._callAPI(systemPrompt, history, options);
        this._healthy = true;
        return result;
      } catch (err) {
        lastError = err;
        console.error(`   ⚠️ LLM API 실패 (${attempt}/${maxRetries}): ${err.message}`);
        if (attempt < maxRetries) {
          await this._sleep(this.retryDelay);
        }
      }
    }

    this._healthy = false;
    throw new Error(`LLM 연결 실패 (${maxRetries}회 재시도 소진): ${lastError?.message}`);
  }

  // ── 내부: API 타입별 호출 ──
  _callAPI(systemPrompt, history, options = {}) {
    switch (this.type) {
      case 'ollama':  return this._callOllama(systemPrompt, history, options);
      case 'openai':  return this._callOpenAI(systemPrompt, history, options);
      case 'google':  return this._callGoogle(systemPrompt, history, options);
      case 'claude':  return this._callClaude(systemPrompt, history, options);
      default:        return this._callOllama(systemPrompt, history, options);
    }
  }

  // ── Ollama (로컬) ──
  _callOllama(systemPrompt, history, options) {
    const parsed = url.parse(this.engineConfig.endpoint);
    const messages = [{ role: 'system', content: systemPrompt }, ...history];
    const body = JSON.stringify({
      model: this.engineConfig.model,
      messages,
      stream: false,
      options: {
        temperature: options.temperature ?? this.temperature,
        num_predict: options.maxTokens ?? this.maxTokens,
      },
    });

    return this._httpRequest(http, {
      hostname: parsed.hostname || '127.0.0.1',
      port: parsed.port || 11434,
      path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, body, (json) => {
      return (json.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    });
  }

  // ── OpenAI / Groq / 호환 API ──
  _callOpenAI(systemPrompt, history, options) {
    const parsed = url.parse(this.engineConfig.endpoint);
    const lib = parsed.protocol === 'https:' ? https : http;
    const messages = [{ role: 'system', content: systemPrompt }, ...history];
    const body = JSON.stringify({
      model: this.engineConfig.model,
      messages,
      temperature: options.temperature ?? this.temperature,
      max_tokens: options.maxTokens ?? this.maxTokens,
    });
    const apiKey = this.engineConfig.apiKey;

    return this._httpRequest(lib, {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: (parsed.path === '/' ? '' : parsed.path) + '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
    }, body, (json) => {
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      return (json.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    });
  }

  // ── Google Gemini (OpenAI 호환 엔드포인트) ──
  _callGoogle(systemPrompt, history, options) {
    const messages = [{ role: 'system', content: systemPrompt }, ...history];
    const body = JSON.stringify({
      model: this.engineConfig.model,
      messages,
      temperature: options.temperature ?? this.temperature,
      max_tokens: options.maxTokens ?? this.maxTokens,
    });
    const apiKey = this.engineConfig.apiKey;

    return this._httpRequest(https, {
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: '/v1beta/openai/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${apiKey}`,
      },
    }, body, (json) => {
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      return (json.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    });
  }

  // ── Anthropic Claude ──
  _callClaude(systemPrompt, history, options) {
    const parsed = url.parse(this.engineConfig.endpoint);
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify({
      model: this.engineConfig.model,
      max_tokens: options.maxTokens ?? this.maxTokens,
      system: systemPrompt,
      messages: history,
    });
    const apiKey = this.engineConfig.apiKey;

    return this._httpRequest(lib, {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, body, (json) => {
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      return (json.content?.[0]?.text || '').trim();
    });
  }

  // ── 공통 HTTP 요청 헬퍼 ──
  _httpRequest(lib, options, body, parser) {
    return new Promise((resolve, reject) => {
      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(parser(json));
          } catch (e) {
            reject(new Error(`Parse error: ${data.substring(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(this.timeout, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = LLMEngine;
