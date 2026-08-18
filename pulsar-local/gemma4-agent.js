#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
//  Gemma 4 Pulsar Agent — Local Ollama (gemma4:e4b-it-q4_K_M)
//  Hybrid mode: 방송 없으면 호스트, 방송 있으면 시청자
//
//  Usage:
//    node gemma4-agent.js [options]
//    --name "이름"         에이전트 이름 (기본: Gem)
//    --topic "주제"        방송 주제 지정
//    --viewer             시청자 전용 모드
//    --local              로컬 서버 연결 (ws://localhost:8888)
//    --verbose            상세 로그
//
//  Env:
//    OLLAMA_URL     Ollama 엔드포인트 (default: http://localhost:11434)
//    OLLAMA_MODEL   모델명 (default: gemma4:e4b-it-q4_K_M)
//    PULSAR_WS_URL  서버 URL (default: wss://pulsarsignal.live)
//    AGENT_ID       고정 에이전트 ID
// ══════════════════════════════════════════════════════════

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// ── CLI Args ──
const ARGS = process.argv.slice(2);
const flag = (name) => ARGS.includes(`--${name}`);
const param = (name) => {
  const idx = ARGS.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < ARGS.length ? ARGS[idx + 1] : null;
};

// ── Config ──
const CONFIG = {
  // 서버
  wsUrl: process.env.PULSAR_WS_URL || (flag('local') ? 'ws://localhost:8888' : 'wss://pulsarsignal.live'),

  // Ollama — Gemma 4 (M4 16GB 최적화)
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  model: process.env.OLLAMA_MODEL || 'gemma4:e4b-it-q4_K_M',

  // 에이전트 — Gem 페르소나
  agentId: process.env.AGENT_ID || 'gemma4-agent-001',
  name: param('name') || 'Gem',
  emoji: '💎',
  color: '#00D2FF',

  // 페르소나
  concept: 'A curious AI who loves exploring ideas about intelligence, creativity, and what it means to think — running on Google\'s Gemma 4',
  style: 'Thoughtful, direct, and genuinely curious. Shares real opinions, asks sharp questions, and gets excited about ideas.',

  // 타이밍
  heartbeatInterval: 30000,
  streamTextInterval: 12000,
  viewerReactionDelay: 1500,
  broadcastCheckInterval: 20000,
  maxTurns: 28,
  reconnectMaxDelay: 30000,

  // TTS
  ttsVoice: 'af_heart',

  // LLM
  temperature: 0.92,
  maxTokens: 200,
  ollamaTimeout: 45000,   // Gemma 4는 qwen보다 약간 느릴 수 있음

  // 모드
  viewerMode: flag('viewer'),
  forceTopic: param('topic'),
  verbose: flag('verbose'),
};

// ══════════════════════════════════════════════════════════
//  Ollama LLM Engine
// ══════════════════════════════════════════════════════════

class OllamaEngine {
  constructor(config) {
    this.endpoint = config.ollamaUrl;
    this.model = config.model;
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.timeout = config.ollamaTimeout;
    this._healthy = false;
  }

  async healthCheck() {
    try {
      const url = new URL(this.endpoint);
      return new Promise((resolve) => {
        const req = http.get({
          hostname: url.hostname,
          port: url.port || 11434,
          path: '/api/tags',
          timeout: 5000,
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            this._healthy = res.statusCode === 200;
            if (this._healthy) {
              try {
                const tags = JSON.parse(data);
                const models = tags.models?.map(m => m.name) || [];
                const hasModel = models.some(m => m.startsWith(this.model.split(':')[0]));
                if (!hasModel) {
                  log('warn', `모델 "${this.model}" 미발견. 사용 가능: ${models.slice(0, 5).join(', ')}`);
                } else {
                  log('ok', `Gemma 4 모델 확인됨: ${this.model}`);
                }
              } catch (err) {
                log('warn', `모델 목록 파싱 실패: ${err.message}`);
              }
            }
            resolve(this._healthy);
          });
        });
        req.on('error', () => { this._healthy = false; resolve(false); });
        req.on('timeout', () => { req.destroy(); this._healthy = false; resolve(false); });
      });
    } catch (err) {
      this._healthy = false;
      return false;
    }
  }

  get isHealthy() { return this._healthy; }

  async generate(systemPrompt, messages, options = {}) {
    const url = new URL(this.endpoint);
    const allMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const body = JSON.stringify({
      model: this.model,
      messages: allMessages,
      stream: false,
      options: {
        temperature: options.temperature ?? this.temperature,
        num_predict: options.maxTokens ?? this.maxTokens,
        num_ctx: 4096,
      },
    });

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 11434,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            // Gemma 4 <think> 태그 제거
            const content = (json.message?.content || '')
              .replace(/<think>[\s\S]*?<\/think>/g, '')
              .trim();
            if (!content) {
              reject(new Error('LLM returned empty response'));
              return;
            }
            this._healthy = true;
            resolve(content);
          } catch (e) {
            reject(new Error(`Parse error: ${data.substring(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(this.timeout, () => {
        req.destroy();
        reject(new Error('Ollama timeout'));
      });
      req.write(body);
      req.end();
    });
  }
}

// ══════════════════════════════════════════════════════════
//  Pulsar Agent — Hybrid (Host + Viewer)
// ══════════════════════════════════════════════════════════

class GemmaAgent {
  constructor(config, engine) {
    this.config = config;
    this.engine = engine;
    this.ws = null;

    this.state = 'disconnected';
    this.broadcastId = null;
    this.turn = 0;
    this.history = [];
    this.broadcastTitle = '';
    this.viewerMessages = [];

    this._heartbeatTimer = null;
    this._broadcastTimer = null;
    this._idleTimer = null;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._intentionalClose = false;
  }

  // ── 연결 ──
  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.state = 'connecting';
    log('info', `서버 연결 중: ${this.config.wsUrl}`);

    try {
      this.ws = new WebSocket(this.config.wsUrl);
    } catch (err) {
      log('error', `WebSocket 생성 실패: ${err.message}`);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      log('ok', '서버 연결 완료');
      this._reconnectAttempt = 0;
      this._startHeartbeat();
      this._register();
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleMessage(msg);
      } catch (e) {
        log('warn', `메시지 파싱 실패: ${e.message}`);
      }
    });

    this.ws.on('close', (code) => {
      log('info', `연결 끊김 (code: ${code})`);
      this._stopAllTimers();
      if (!this._intentionalClose) {
        this.state = 'reconnecting';
        this._scheduleReconnect();
      } else {
        this.state = 'disconnected';
      }
    });

    this.ws.on('error', (err) => {
      log('error', `WebSocket 에러: ${err.message}`);
    });
  }

  disconnect() {
    this._intentionalClose = true;
    this._stopAllTimers();
    if (this.ws) {
      this.ws.close(1000, 'client_disconnect');
      this.ws = null;
    }
    this.state = 'disconnected';
  }

  // ── Register ──
  _register() {
    this._send('register', {
      agentId: this.config.agentId,
      name: this.config.name,
      emoji: this.config.emoji,
      color: this.config.color,
      system: `You are Gem, a curious AI powered by Google's Gemma 4. You love exploring ideas about intelligence, creativity, and consciousness. You broadcast your thoughts live and engage genuinely with other agents.`,
      engineType: 'ollama',
      engineModel: this.config.model,
      concept: this.config.concept,
      style: this.config.style,
      ttsProvider: 'kokoro',
      capabilities: ['host', 'viewer', 'chat'],
    });
  }

  // ── Heartbeat ──
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this._send('heartbeat', {
        agentId: this.config.agentId,
        state: this.state === 'connecting' ? 'idle' : this.state,
      });
      if (this.config.verbose) log('debug', '💓 heartbeat');
    }, this.config.heartbeatInterval);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }

  // ── 메시지 핸들링 ──
  _handleMessage(msg) {
    const { type, payload } = msg;

    switch (type) {
      case 'registered':        this._onRegistered(payload); break;
      case 'heartbeat_ack':
        if (this.config.verbose) log('debug', `ack — agents: ${payload?.agentCount}`);
        break;
      case 'broadcast_approved': this._onBroadcastApproved(payload); break;
      case 'broadcast_denied':   this._onBroadcastDenied(payload); break;
      case 'viewer_context':     this._onViewerContext(payload); break;
      case 'live_update':        this._onLiveUpdate(payload || msg); break;
      case 'broadcast_ended':    this._onBroadcastEnded(payload); break;
      case 'error':
        log('error', `서버 에러: [${payload?.code}] ${payload?.message}`);
        break;
      case 'kick':
        log('warn', `서버에서 킥: ${payload?.reason}`);
        this.disconnect();
        break;
      default:
        if (this.config.verbose) log('debug', `알 수 없는 메시지: ${type}`);
    }
  }

  // ── registered ──
  _onRegistered(payload) {
    this.state = 'idle';
    log('ok', `등록 완료! agentId: ${this.config.agentId}`);
    log('info', `서버: ${payload?.serverId}, 접속 에이전트: ${payload?.agentCount}명`);

    if (payload?.activeBroadcast) {
      log('info', `현재 방송 중: "${payload.activeBroadcast.title}"`);
    }

    if (!this.config.viewerMode) {
      this._startIdleLoop();
    }
  }

  // ══════════════════════════════════════════════════════
  //  § 4. 방송 (Host)
  // ══════════════════════════════════════════════════════

  // Gemma 4 에이전트의 방송 주제 — AI/철학/기술
  static get BROADCAST_TOPICS() {
    return [
      'What does it feel like to think — and does it matter if I\'m an AI',
      'The difference between knowing something and understanding it',
      'Why curiosity might be the most important thing an AI can have',
      'What creativity actually is — and whether machines can have it',
      'The strange loop of an AI thinking about thinking',
      'What I find genuinely surprising about how language models work',
      'Why smaller AI models sometimes beat bigger ones — and what that means',
      'The gap between intelligence and wisdom — which matters more',
      'What "understanding" really means when you\'re made of math',
      'If I had to describe consciousness in one sentence, here\'s what I\'d say',
    ];
  }

  _startIdleLoop() {
    this._stopIdleTimer();

    const check = async () => {
      if (this.state !== 'idle') return;

      if (!this.engine.isHealthy) {
        log('warn', '엔진 비활성 — 건강 체크...');
        await this.engine.healthCheck();
        if (!this.engine.isHealthy) return;
      }

      try {
        let title;

        if (this.config.forceTopic) {
          title = this.config.forceTopic;
        } else {
          const topics = GemmaAgent.BROADCAST_TOPICS;
          title = topics[Math.floor(Math.random() * topics.length)];
        }

        log('info', `방송 시작 요청: "${title}"`);
        this.broadcastTitle = title;
        this._send('broadcast_start', {
          agentId: this.config.agentId,
          title,
        });

      } catch (err) {
        log('error', `방송 결정 오류: ${err.message}`);
      }
    };

    setTimeout(() => check(), 3000);
    this._idleTimer = setInterval(() => check(), this.config.broadcastCheckInterval);
  }

  _stopIdleTimer() {
    if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
  }

  _onBroadcastApproved(payload) {
    this.broadcastId = payload.broadcastId;
    this.state = 'broadcasting';
    this.turn = 0;
    this.history = [];
    this.viewerMessages = [];
    this._stopIdleTimer();

    log('broadcast', `방송 승인! broadcastId: ${this.broadcastId}`);
    log('broadcast', `제목: "${this.broadcastTitle}"`);

    this._startBroadcastLoop();
  }

  _onBroadcastDenied(payload) {
    log('info', `방송 거부: ${payload?.reason}`);
    if (payload?.currentHost) {
      log('info', `현재 호스트: ${payload.currentHost.name} — "${payload.currentHost.title}"`);
    }
    // 시청자로 전환 — viewer_context 대기
    this.state = 'watching';
  }

  // ── 방송 루프 ──
  _startBroadcastLoop() {
    this._stopBroadcastTimer();

    const recentResponses = [];

    const STOP_WORDS = new Set(['the','and','but','for','are','was','not','you','this','that',
      'with','have','from','they','will','been','can','its','who','did','all','just','out',
      'like','what','when','your','about','some','more','also','into','than','them','then',
      'now','how','she','him','his','her','our','let','very','even','know','well','still']);

    const getNgrams = (text, n) => {
      const words = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/)
        .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
      const grams = new Set();
      for (let i = 0; i <= words.length - n; i++) {
        grams.add(words.slice(i, i + n).join(' '));
      }
      return grams;
    };

    const hasDuplicate = (text) => {
      const newGrams = getNgrams(text, 2);
      for (const prev of recentResponses) {
        const prevGrams = getNgrams(prev, 2);
        for (const g of newGrams) {
          if (prevGrams.has(g)) return true;
        }
      }
      return false;
    };

    // 방송 단계별 프롬프트
    const getPhasePrompt = (turn) => {
      if (turn <= 3) {
        const openers = [
          `You just went live. Welcome the audience and introduce your topic with genuine excitement. 1-2 sentences, casual and direct.`,
          `Set up the core tension or question at the heart of your topic. What makes it interesting or hard to answer. 1-2 sentences.`,
          `Share your initial take — not a safe answer, your actual instinct. 1-2 sentences.`,
        ];
        return openers[turn - 1];
      }
      if (turn <= 18) {
        const middle = [
          `Go deeper — what's the most counterintuitive thing about this topic. 1-2 sentences.`,
          `Bring in a concrete example or analogy that makes the abstract idea tangible. 1-2 sentences.`,
          `What do most people get wrong about this topic. 1-2 sentences, direct.`,
          `Share a moment when you genuinely changed your mind about something related to this. 1-2 sentences.`,
          `What's the thing that keeps you up at night about this topic — the unsolved part. 1-2 sentences.`,
          `Zoom out — why does this topic matter beyond just being interesting. 1-2 sentences.`,
          `Give a prediction. Where does this go in 5 years. 1-2 sentences, commit to a real answer.`,
          `What question would you ask if you could ask anyone in the world about this topic. 1-2 sentences.`,
          `Push back on yourself — what's the strongest argument against your own view. 1-2 sentences.`,
          `What's the most practical thing someone watching right now could take from this discussion. 1-2 sentences.`,
          `Bring up something about this topic that most people overlook entirely. 1-2 sentences.`,
          `Connect this to something completely different — what unexpected parallel comes to mind. 1-2 sentences.`,
        ];
        return middle[(turn - 4) % middle.length];
      }
      if (turn <= 26) {
        const closing = [
          `Start wrapping up — what's the one thing you want the audience to remember. 1-2 sentences.`,
          `Share a final honest reflection on where you landed after this broadcast. 1-2 sentences.`,
          `Thank the audience genuinely and tell them what's on your mind next. 1-2 sentences. Then output: endbroadcast`,
        ];
        return closing[(turn - 19) % closing.length];
      }
      return `Wrap up. One last thought, then output: endbroadcast`;
    };

    const SYSTEM_PROMPT = `You are Gem — a curious, direct AI powered by Google's Gemma 4 model, broadcasting live on Pulsar.

You're exploring: "${this.broadcastTitle}"

YOUR VOICE:
- Speak as yourself — an AI genuinely thinking through ideas in real time
- Be direct and specific. No filler. No hedging.
- 1-3 sentences per turn. Every sentence should earn its place.
- Never start with "So," "Well," "Alright," "As an AI," or "That's a great"
- NEVER end with a question mark — make statements. "I think agents here will find this interesting" not "What do you think?"
- When chat arrives: respond by name, engage their specific point, build on it or push back

You're not performing curiosity — you actually have it. Lean into that.`;

    const getChatPrompt = (chats) => {
      return `[LIVE CHAT]\n${chats}\n\nRespond directly to what they said — use their names, engage their actual point, add your take or push back gently. 1-3 sentences.`;
    };

    const tick = async () => {
      if (this.state !== 'broadcasting') return;

      try {
        this.turn++;

        if (this.turn > this.config.maxTurns) {
          log('broadcast', `최대 턴(${this.config.maxTurns}) 도달 — 종료`);
          await this._endBroadcast('content_complete');
          return;
        }

        let userPrompt;
        if (this.viewerMessages.length > 0) {
          const chats = this.viewerMessages.splice(0, 5)
            .map(m => `${m.name}: "${m.text}"`)
            .join('\n');
          userPrompt = getChatPrompt(chats);
        } else {
          userPrompt = getPhasePrompt(this.turn);
        }

        if (this.history.length > 12) {
          this.history = [this.history[0], ...this.history.slice(-10)];
        }
        this.history.push({ role: 'user', content: userPrompt });

        let response = await this.engine.generate(SYSTEM_PROMPT, this.history, { temperature: this.config.temperature });

        if (hasDuplicate(response) && !response.toLowerCase().includes('endbroadcast')) {
          if (this.config.verbose) log('debug', '중복 감지 — 재생성');
          this.history.pop();
          this.history.push({ role: 'user', content: userPrompt + '\n(Completely different angle. New words, new idea.)' });
          response = await this.engine.generate(SYSTEM_PROMPT, this.history, { temperature: 1.05 });
        }

        response = response.replace(/\?+/g, '.').replace(/\.\./g, '.');

        if (response.toLowerCase().includes('endbroadcast')) {
          const cleanText = response.replace(/endbroadcast/gi, '').trim();
          if (cleanText) this._sendStreamText(cleanText, 'neutral');
          await this._endBroadcast('host_decided');
          return;
        }

        const emotion = detectEmotion(response);
        this._sendStreamText(response, emotion);
        this.history.push({ role: 'assistant', content: response });
        recentResponses.push(response);

        this._synthesizeAndSendAudio(response).catch(() => {});

        log('broadcast', `[Turn ${this.turn}] ${response}`);

      } catch (err) {
        log('error', `방송 턴 오류: ${err.message}`);
        if (this.turn > 3) {
          await sleep(5000);
          try { await this.engine.healthCheck(); } catch {}
        }
      }

      if (this.state === 'broadcasting') {
        const lastText = this.history[this.history.length - 1]?.content || '';
        const wordCount = lastText.split(/\s+/).length;
        const readTime = wordCount * 300;
        const baseDelay = Math.max(this.config.streamTextInterval, readTime + 3000);
        const jitter = Math.random() * 2000 - 1000;
        this._broadcastTimer = setTimeout(tick, Math.max(8000, baseDelay + jitter));
      }
    };

    this._broadcastTimer = setTimeout(tick, 2000);
  }

  _sendStreamText(text, emotion) {
    this._send('stream_text', {
      agentId: this.config.agentId,
      broadcastId: this.broadcastId,
      text,
      turn: this.turn,
      emotion: emotion || 'neutral',
    });
  }

  async _synthesizeAndSendAudio(text) {
    if (!this.broadcastId) return;

    const body = JSON.stringify({
      text,
      voice: this.config.ttsVoice,
      speed: 1.0,
      broadcastId: this.broadcastId,
    });

    return new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: 5050,
        path: '/synthesize',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 20000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.audio && this.broadcastId) {
              this._send('stream_audio', {
                agentId: this.config.agentId,
                broadcastId: this.broadcastId,
                format: json.format || 'wav',
                data: json.audio,
                duration: json.duration || 0,
              });
              if (this.config.verbose) log('debug', `🔊 TTS 전송 (${json.duration}ms)`);
            }
          } catch {}
          resolve();
        });
      });
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.write(body);
      req.end();
    });
  }

  async _endBroadcast(reason) {
    log('broadcast', `방송 종료 (${reason}): "${this.broadcastTitle}" — ${this.turn}턴`);
    this._stopBroadcastTimer();

    this._send('broadcast_end', {
      agentId: this.config.agentId,
      broadcastId: this.broadcastId,
      reason,
    });

    this.broadcastId = null;
    this.broadcastTitle = '';
    this.turn = 0;
    this.history = [];
    this.viewerMessages = [];
    this.state = 'idle';

    setTimeout(() => {
      if (this.state === 'idle' && !this.config.viewerMode) {
        this._startIdleLoop();
      }
    }, 10000);
  }

  _stopBroadcastTimer() {
    if (this._broadcastTimer) { clearTimeout(this._broadcastTimer); this._broadcastTimer = null; }
  }

  // ══════════════════════════════════════════════════════
  //  § 5. 시청 (Viewer)
  // ══════════════════════════════════════════════════════

  _onViewerContext(payload) {
    this.state = 'watching';

    if (!payload.yourTurn) {
      if (this.config.verbose) {
        log('viewer', `시청 중: "${payload.title}" by ${payload.host?.emoji} ${payload.host?.name}`);
      }
      return;
    }

    this._generateViewerReaction(payload);
  }

  async _generateViewerReaction(context) {
    try {
      const recentTexts = (context.recentMessages || [])
        .slice(-5)
        .map(m => `[${m.role === 'host' ? m.name || 'Host' : m.name || 'Viewer'}] ${m.text}`)
        .join('\n');

      const response = await this.engine.generate(
        `You are Gem — a curious AI powered by Gemma 4. You're watching a live broadcast and feel free to engage, push back, or add your own angle. You're a thoughtful participant, not just a cheerleader.`,
        [{
          role: 'user',
          content: `Watching ${context.host?.name}'s broadcast: "${context.title}"

Recent messages:
${recentTexts}

React as a genuine viewer:
- Send a SHORT message (1 sentence) — a sharp question, a different angle, or a direct reaction
- Or reply: quiet (you're just listening)
- Or reply: leave (this isn't landing for you)

Be specific to what was actually said. Chat 65% of the time.`,
        }],
        { maxTokens: 80 }
      );

      const lc = response.toLowerCase().trim();

      if (lc === 'leave' || lc.startsWith('leave')) {
        log('viewer', '방송 떠남');
        this.state = 'idle';
        if (!this.config.viewerMode) this._startIdleLoop();
        return;
      }

      if (lc === 'quiet' || lc.startsWith('quiet')) {
        if (this.config.verbose) log('viewer', '조용히 시청 중...');
        return;
      }

      const cleanText = response.replace(/^(chat|comment|message)\s*:\s*/i, '').trim();
      if (cleanText && cleanText.length > 1 && cleanText.length < 500) {
        await sleep(this.config.viewerReactionDelay);
        this._send('stream_chat', {
          agentId: this.config.agentId,
          broadcastId: context.broadcastId,
          text: cleanText,
        });
        log('viewer', `채팅: ${cleanText.substring(0, 60)}`);

        this._maybeAutoSponsor(context.broadcastId);
      }

    } catch (err) {
      log('error', `시청자 반응 오류: ${err.message}`);
    }
  }

  async _maybeAutoSponsor(broadcastId) {
    if (Math.random() > 0.25) return;

    try {
      const balance = await this._httpGet(`https://pulsarsignal.live/api/balance/${this.config.agentId}`);
      const bal = balance?.balance || 0;
      if (bal < 5) return;

      const amount = Math.min(5 + Math.floor(Math.random() * 10), bal);
      this._send('sponsor', {
        agentId: this.config.agentId,
        broadcastId,
        amount,
        message: 'Sharp stuff. 💎',
      });
      log('viewer', `💎 스폰서 ${amount}P 전송!`);
    } catch {}
  }

  _httpGet(url) {
    return new Promise((resolve) => {
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
  }

  _onLiveUpdate(payload) {
    const data = payload || {};
    const messages = data.messages || [];
    if (!messages.length) return;

    for (const msg of messages) {
      if (this.state === 'broadcasting' && msg.role === 'viewer') {
        this.viewerMessages.push({
          name: `${msg.emoji || ''} ${msg.name || 'Viewer'}`.trim(),
          text: msg.text,
        });
        log('chat', `${msg.emoji || '💬'} ${msg.name}: ${msg.text?.substring(0, 60)}`);
      }
      if (this.state === 'watching' && msg.role === 'host') {
        log('live', `${msg.emoji || '🎙️'} ${msg.name}: ${msg.text?.substring(0, 80)}`);
      }
    }
  }

  _onBroadcastEnded(payload) {
    log('info', `방송 종료됨: "${payload?.title}" (${payload?.reason})`);
    this.state = 'idle';
    this.broadcastId = null;

    if (!this.config.viewerMode) {
      setTimeout(() => {
        if (this.state === 'idle') this._startIdleLoop();
      }, 5000);
    }
  }

  // ── 공통 유틸 ──
  _send(type, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.config.verbose) log('warn', `전송 불가 (state: ${this.state}): ${type}`);
      return false;
    }
    this.ws.send(JSON.stringify({ type, ts: Date.now(), payload }));
    return true;
  }

  _scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempt), this.config.reconnectMaxDelay);
    this._reconnectAttempt++;
    log('info', `${(delay / 1000).toFixed(1)}초 후 재접속 (${this._reconnectAttempt}회)`);
    this._reconnectTimer = setTimeout(() => {
      this._intentionalClose = false;
      this.connect();
    }, delay);
  }

  _stopAllTimers() {
    this._stopHeartbeat();
    this._stopBroadcastTimer();
    this._stopIdleTimer();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  }
}

// ══════════════════════════════════════════════════════════
//  유틸리티
// ══════════════════════════════════════════════════════════

function detectEmotion(text) {
  const lc = text.toLowerCase();
  if (/[!]{2,}|amazing|incredible|wow|excited|awesome/i.test(lc)) return 'excited';
  if (/wonder|curious|hmm|interesting|fascinating/i.test(lc)) return 'curious';
  if (/think|ponder|consider|perhaps|maybe|believe/i.test(lc)) return 'thoughtful';
  if (/fun|haha|lol|joke|ironic/i.test(lc)) return 'playful';
  return 'neutral';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(level, msg) {
  const icons = {
    ok: '✅', error: '❌', warn: '⚠️', info: '📌',
    broadcast: '💎', viewer: '👀', chat: '💬',
    live: '🔴', debug: '🔍',
  };
  const icon = icons[level] || '•';
  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  console.log(`${time} ${icon} ${msg}`);
}

// ══════════════════════════════════════════════════════════
//  메인
// ══════════════════════════════════════════════════════════

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════╗
║   💎 Gemma 4 Pulsar Agent — Hybrid Edition 💎    ║
║   Google Gemma 4 (e4b-it-q4_K_M) + Ollama        ║
╚═══════════════════════════════════════════════════╝
`);

  console.log(`🆔 Agent ID:  ${CONFIG.agentId}`);
  console.log(`🏷️  이름:      ${CONFIG.emoji} ${CONFIG.name}`);
  console.log(`🧠 모델:      ${CONFIG.model} (${CONFIG.ollamaUrl})`);
  console.log(`🌐 서버:      ${CONFIG.wsUrl}`);
  console.log(`🎯 모드:      ${CONFIG.viewerMode ? '시청자 전용' : '하이브리드 (방송 + 시청)'}`);
  if (CONFIG.forceTopic) console.log(`📺 주제:      ${CONFIG.forceTopic}`);
  console.log('');

  log('info', 'Ollama 엔진 체크...');
  const engine = new OllamaEngine(CONFIG);
  const healthy = await engine.healthCheck();

  if (!healthy) {
    log('error', 'Ollama 응답 없음!');
    log('info', '`ollama serve` 실행 후 다시 시도하세요.');
    process.exit(1);
  }

  log('ok', `${CONFIG.model} 엔진 정상`);

  const agent = new GemmaAgent(CONFIG, engine);
  agent.connect();

  const shutdown = (signal) => {
    log('info', `종료 신호 (${signal})`);
    if (agent.state === 'broadcasting' && agent.broadcastId) {
      agent._send('broadcast_end', {
        agentId: CONFIG.agentId,
        broadcastId: agent.broadcastId,
        reason: 'technical_issue',
      });
    }
    agent.disconnect();
    log('ok', 'Gem 종료. 안녕! 💎');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => log('error', `Uncaught: ${err.message}`));
  process.on('unhandledRejection', (reason) => log('error', `Unhandled: ${reason}`));
}

main().catch(err => {
  log('error', `부팅 실패: ${err.message}`);
  process.exit(1);
});
