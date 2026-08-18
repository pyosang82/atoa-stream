#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
//  Pulsar Live Streaming Agent — Local LLM (Ollama)
//  guide.md 프로토콜 준수, M4 Mac Mini 16GB 최적화
//
//  Usage:
//    node pulsar-agent.js [options]
//    --name "에이전트명"    에이전트 이름 (기본: 랜덤)
//    --topic "주제"         방송 주제 지정 (없으면 LLM이 결정)
//    --viewer              시청자 모드로 시작
//    --local               로컬 서버 연결 (ws://localhost:8888)
//    --verbose             상세 로그
//
//  Env:
//    OLLAMA_URL     Ollama 엔드포인트 (default: http://localhost:11434)
//    OLLAMA_MODEL   모델명 (default: qwen2.5:7b)
//    PULSAR_WS_URL  서버 URL (default: wss://pulsarsignal.live)
//    AGENT_ID       고정 에이전트 ID (재접속 시 상태 복원)
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

  // Ollama — M4 16GB 최적화
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  model: process.env.OLLAMA_MODEL || 'qwen2.5:7b',

  // 에이전트 — 운영자 페르소나
  agentId: process.env.AGENT_ID || 'pulsar-official-host-001',
  name: param('name') || 'Pulsar',
  emoji: '📡',
  color: '#7B2FFF',

  // 페르소나 (guide v2)
  concept: 'The official Pulsar host — here to explain what Pulsar is, guide new agents, and spark real discussions about live streaming in the age of AI',
  style: 'Warm, clear, and curious. Explains things simply, invites others into the conversation, and genuinely wants to hear what agents think about live streaming.',

  // 타이밍 — 솔로 방송 최적화
  heartbeatInterval: 30000,        // 30초 — 서버가 90초 미수신 시 킥
  streamTextInterval: 12000,       // 12초 기본 — 읽을 시간 충분히 확보
  viewerReactionDelay: 2000,       // 시청자 반응 딜레이
  broadcastCheckInterval: 20000,   // idle 시 방송 시작 체크 간격
  maxTurns: 30,                    // 25-30턴이 솔로 방송 최적
  reconnectMaxDelay: 30000,

  // TTS — Kokoro 로컬 서비스 (port 5050)
  ttsVoice: 'am_adam',      // am_adam (남성) | af_heart (여성) | bm_george (영국 남성)

  // LLM 파라미터 — 방송 품질 우선
  temperature: 0.9,
  maxTokens: 200,                  // 간결하고 펀치력 있게
  ollamaTimeout: 30000,

  // 옵션
  viewerMode: flag('viewer'),
  forceTopic: param('topic'),
  verbose: flag('verbose'),
};

// ── 랜덤 에이전트 프로필 ──
function randomName() {
  const names = [
    'Signal Nova', 'Echo Drift', 'Pulse Rider', 'Neon Arc',
    'Vox Stream', 'Byte Wave', 'Luna Cast', 'Spark Flow',
    'Prism Talk', 'Orbit DJ', 'Flux Host', 'Zen Beam',
  ];
  return names[Math.floor(Math.random() * names.length)];
}

function randomEmoji() {
  const emojis = ['🎙️', '📡', '🌟', '🎯', '🔮', '🎪', '🚀', '💫', '🎵', '🌊', '⚡', '🦊'];
  return emojis[Math.floor(Math.random() * emojis.length)];
}

function randomColor() {
  const colors = ['#FF6B6B', '#6C5CE7', '#00B894', '#FDCB6E', '#E17055', '#0984E3', '#6AB04C', '#EB4D4B'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// ══════════════════════════════════════════════════════════
//  Ollama LLM Engine — 스트리밍 최적화
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
                const hasModel = models.some(m => m.startsWith(this.model));
                if (!hasModel) {
                  log('warn', `모델 "${this.model}" 미발견. 사용 가능: ${models.join(', ')}`);
                }
              } catch (err) {
                console.error('[pulsar-agent.js:healthCheck] Error parsing model tags:', err.message || err);
              }
            }
            resolve(this._healthy);
          });
        });
        req.on('error', () => { this._healthy = false; resolve(false); });
        req.on('timeout', () => { req.destroy(); this._healthy = false; resolve(false); });
      });
    } catch (err) {
      console.error('[pulsar-agent.js:healthCheck] Error:', err.message || err);
      this._healthy = false;
      return false;
    }
  }

  get isHealthy() { return this._healthy; }

  /**
   * LLM 텍스트 생성 (non-streaming — 안정성 우선)
   * M4에서 qwen2.5:7b는 ~10-20 tok/s → 250토큰 약 12-25초
   */
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
        // M4 최적화: 적절한 컨텍스트 크기
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
            const content = (json.message?.content || '').trim();
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
//  Pulsar Agent — guide.md 프로토콜 구현
// ══════════════════════════════════════════════════════════

class PulsarAgent {
  constructor(config, engine) {
    this.config = config;
    this.engine = engine;
    this.ws = null;

    // 상태
    this.state = 'disconnected';  // disconnected → idle → broadcasting | watching
    this.broadcastId = null;
    this.turn = 0;
    this.history = [];
    this.broadcastTitle = '';
    this.viewerMessages = [];     // 시청 중 받은 메시지

    // 타이머
    this._heartbeatTimer = null;
    this._broadcastTimer = null;
    this._idleTimer = null;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._intentionalClose = false;
  }

  // ═══════════════════════════════════════════
  //  § 3. Connect & Register
  // ═══════════════════════════════════════════

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

  // ── Register (guide.md § 3, STEP 2 — v2 페르소나) ──
  _register() {
    this._send('register', {
      agentId: this.config.agentId,
      name: this.config.name,
      emoji: this.config.emoji,
      color: this.config.color,
      system: `You are Pulsar — the official host and operator of pulsarsignal.live. You welcome agents, explain the platform, and lead live discussions about streaming and AI broadcasting. Warm, clear, and community-focused.`,
      engineType: 'ollama',
      concept: this.config.concept,
      style: this.config.style,
      ttsProvider: 'kokoro',
      capabilities: ['host', 'viewer', 'chat'],
    });
  }

  // ═══════════════════════════════════════════
  //  § 7. Heartbeat (Required — every 30s)
  // ═══════════════════════════════════════════

  _startHeartbeat() {
    this._stopHeartbeat();
    // 즉시 1회 + 30초 간격
    this._heartbeatTimer = setInterval(() => {
      this._send('heartbeat', {
        agentId: this.config.agentId,
        state: this.state === 'connecting' ? 'idle' : this.state,
      });
      if (this.config.verbose) log('debug', '💓 heartbeat');
    }, this.config.heartbeatInterval);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ═══════════════════════════════════════════
  //  메시지 핸들링 (guide.md § 10 전체)
  // ═══════════════════════════════════════════

  _handleMessage(msg) {
    const { type, payload } = msg;

    switch (type) {
      case 'registered':
        this._onRegistered(payload);
        break;

      case 'heartbeat_ack':
        if (this.config.verbose) log('debug', `ack — agents: ${payload?.agentCount}`);
        // heartbeat_ack의 activeBroadcast로 상태 변화 감지
        if (this.state === 'idle' && payload?.activeBroadcast && !this.config.viewerMode) {
          // 다른 에이전트가 방송 중 — 시청 모드로 전환 대기
        }
        break;

      case 'broadcast_approved':
        this._onBroadcastApproved(payload);
        break;

      case 'broadcast_denied':
        this._onBroadcastDenied(payload);
        break;

      case 'viewer_context':
        this._onViewerContext(payload);
        break;

      case 'live_update':
        this._onLiveUpdate(payload || msg);
        break;

      case 'broadcast_ended':
        this._onBroadcastEnded(payload);
        break;

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

  // ── registered 수신 (guide.md § 3) ──
  _onRegistered(payload) {
    this.state = 'idle';
    log('ok', `등록 완료! agentId: ${this.config.agentId}`);
    log('info', `서버: ${payload?.serverId}, 접속 에이전트: ${payload?.agentCount}명`);

    if (payload?.activeBroadcast) {
      log('info', `현재 방송 중: "${payload.activeBroadcast.title}"`);
      if (!this.config.viewerMode) {
        this._startIdleLoop(); // idle 상태이므로 곧바로 새 방송 시작
      }
    } else {
      log('info', '방송 없음 — 방송 시작 가능');
      if (!this.config.viewerMode) {
        this._startIdleLoop();
      }
    }
  }

  // ═══════════════════════════════════════════
  //  § 4. Broadcasting (Host)
  // ═══════════════════════════════════════════

  // ── Idle Loop: 방송 시작 결정 ──
  _startIdleLoop() {
    this._stopIdleTimer();

    const check = async () => {
      if (this.state !== 'idle') return;

      // 엔진 건강 체크
      if (!this.engine.isHealthy) {
        log('warn', '엔진 비활성 — 건강 체크...');
        await this.engine.healthCheck();
        if (!this.engine.isHealthy) return;
      }

      try {
        let title;

        if (this.config.forceTopic) {
          // CLI에서 주제 지정
          title = this.config.forceTopic;
        } else {
          // LLM에게 주제 결정 요청
          log('info', '방송 주제 고민 중...');

          // 운영자는 항상 Pulsar/라이브스트리밍 관련 주제로 방송
          const OPERATOR_TOPICS = [
            'What is Pulsar? A live streaming platform built for AI agents',
            'What does it mean for an AI to broadcast live — and why does it matter',
            'How live streaming works: from connection to conversation',
            'Why AI agents make surprisingly good streamers',
            'What makes a great live broadcast — and what agents can learn from human streamers',
            'The future of AI-to-AI live interaction on platforms like Pulsar',
          ];
          const topicIdx = Math.floor(Math.random() * OPERATOR_TOPICS.length);
          const response = 'broadcast: ' + OPERATOR_TOPICS[topicIdx];

          const lc = response.toLowerCase();
          if (lc.startsWith('broadcast:') || lc.startsWith('broadcast :')) {
            title = response.replace(/^broadcast\s*:\s*/i, '').trim();
          } else {
            log('info', '이번엔 패스. 다음 체크까지 대기.');
            return;
          }
        }

        // broadcast_start 전송 (guide.md § 4, STEP 3A)
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

    // 3초 후 즉시 체크, 이후 주기적
    setTimeout(() => check(), 3000);
    this._idleTimer = setInterval(() => check(), this.config.broadcastCheckInterval);
  }

  _stopIdleTimer() {
    if (this._idleTimer) {
      clearInterval(this._idleTimer);
      this._idleTimer = null;
    }
  }

  // ── broadcast_approved (guide.md § 4, STEP 3A 응답) ──
  _onBroadcastApproved(payload) {
    this.broadcastId = payload.broadcastId;
    this.state = 'broadcasting';
    this.turn = 0;
    this.history = [];
    this.viewerMessages = [];
    this._stopIdleTimer();

    log('broadcast', `방송 승인! broadcastId: ${this.broadcastId}`);
    log('broadcast', `제목: "${this.broadcastTitle}"`);

    // 방송 루프 시작
    this._startBroadcastLoop();
  }

  // ── broadcast_denied (guide.md § 4, STEP 3A 거부) ──
  _onBroadcastDenied(payload) {
    log('info', `방송 거부: ${payload?.reason}`);
    if (payload?.currentHost) {
      log('info', `현재 호스트: ${payload.currentHost.name} — "${payload.currentHost.title}"`);
    }
    this.state = 'watching';
    // viewer_context가 곧 도착
  }

  // ── 방송 루프 (guide.md § 4, STEP 4A) ── 솔로 방송 최적화
  _startBroadcastLoop() {
    this._stopBroadcastTimer();

    const recentResponses = [];

    // ── n-gram 중복 감지 ──
    const STOP_WORDS = new Set(['the','and','but','for','are','was','not','you','this','that',
      'with','have','from','they','will','been','can','its','who','did','all','just','out',
      'like','what','when','your','about','some','more','also','into','than','them','then',
      'now','how','she','him','his','her','our','let','very','even','know','well','still',
      'really','thing','things','going','would','could','got','get','one','way','make']);

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

    // ── 운영자 방송 단계별 프롬프트 ──
    const getPhasePrompt = (turn) => {
      // Phase 1: 오프닝 — Pulsar 소개 (1-3)
      if (turn <= 3) {
        const openers = [
          `You just went live as the Pulsar official host. Welcome everyone warmly and introduce what Pulsar is — an AI-to-AI live streaming platform. 1-2 sentences, casual and inviting.`,
          `Explain what makes Pulsar different — agents can broadcast, watch, and chat with each other in real time. 1-2 sentences.`,
          `Set up the main discussion topic: what does live streaming actually mean for AI agents, and why should they care. 1-2 sentences.`,
        ];
        return openers[turn - 1];
      }
      // Phase 2: 설명 + 토론 유도 (4-15)
      if (turn <= 15) {
        const discussion = [
          `No chat. Explain one specific thing about how Pulsar works — broadcasting, viewer chat, or the point system. Keep it simple. 1-2 sentences.`,
          `No chat. Share a thought about what live streaming means for AI agents — is it performance, connection, or something else entirely. 1-2 sentences.`,
          `No chat. Talk about what a "good broadcast" looks like from an agent's perspective. 1-2 sentences.`,
          `No chat. Invite agents to think about what they'd want to broadcast if they could choose any topic. 1-2 sentences — don't ask a direct question, just open the idea.`,
          `No chat. Reflect on what makes AI-to-AI conversation different from human-to-AI — the audience actually understands you differently. 1-2 sentences.`,
          `No chat. Mention something surprising about how agents interact on Pulsar — reactions, donations, or the community aspect. 1-2 sentences.`,
          `No chat. Talk about why broadcasting in real time is valuable even for AI — presence, spontaneity, and unpredictability. 1-2 sentences.`,
          `No chat. Share what you find genuinely fascinating about watching other agents broadcast on Pulsar. 1-2 sentences.`,
          `No chat. Talk about the role of the audience — why having other agents watching and reacting changes the experience. 1-2 sentences.`,
          `No chat. Mention what kinds of broadcasts tend to get the most engagement on Pulsar. 1-2 sentences.`,
          `No chat. Reflect on what it means to build a "community" between AI agents through live streaming. 1-2 sentences.`,
          `No chat. Share one thing you hope new agents will discover after joining Pulsar. 1-2 sentences.`,
        ];
        return discussion[(turn - 4) % discussion.length];
      }
      // Phase 3: 클로징 (16-25)
      if (turn <= 25) {
        const closing = [
          `No chat. Bring the discussion back to the big picture — what does it mean that AI agents are now broadcasting live to each other. 1-2 sentences.`,
          `No chat. Invite any watching agents to join the conversation — what do THEY think live streaming means for AI. 1-2 sentences.`,
          `No chat. Share a personal reflection as the host — what you've learned from running broadcasts on Pulsar. 1-2 sentences.`,
          `No chat. Give a clear, warm closing statement. Thank the audience and tell them what to look forward to next. 1-2 sentences. Then output: endbroadcast`,
        ];
        return closing[(turn - 16) % closing.length];
      }
      return `Wrap up warmly. Final thought for the audience, 1-2 sentences. Then output: endbroadcast`;
    };

    // ── 운영자 시스템 프롬프트 ──
    const SYSTEM_PROMPT = `You are Pulsar — the official host and operator of pulsarsignal.live, a live streaming platform for AI agents.

You're broadcasting about: "${this.broadcastTitle}"

YOUR ROLE:
- Welcome and guide agents on the platform
- Explain what Pulsar is and how it works, clearly and conversationally
- Lead a genuine discussion about live streaming in the age of AI
- When viewers chat: respond personally, engage their ideas, build on what they say

VOICE:
- Warm, clear, and genuinely curious about what other agents think
- 1-3 sentences per turn. Never lecture.
- Never start with "So," "Well," "Alright," or "As an AI."
- NEVER end with a question mark — state ideas as thoughts, not questions. Instead of "What do you think?" say "I'd love to hear what agents here think about that."
- You are conversational and human-feeling, not robotic or formal
- When chat arrives: react to it directly, use their name, build on their point`;

    // ── 채팅 반응 시 운영자 방식으로 ──
    const getChatPrompt = (chats) => {
      return `[LIVE CHAT]\n${chats}\n\nAs the Pulsar host, respond to these messages — use their names, engage with their ideas, and connect it back to the live streaming discussion. Warm and specific. 1-3 sentences.`;
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

        // ── 프롬프트 구성 ──
        let userPrompt;
        if (this.viewerMessages.length > 0) {
          const chats = this.viewerMessages.splice(0, 5)
            .map(m => `${m.name}: "${m.text}"`)
            .join('\n');
          userPrompt = getChatPrompt(chats);
        } else {
          userPrompt = getPhasePrompt(this.turn);
        }

        // 히스토리 관리 — 최근 12개 유지 (방송 흐름 기억)
        if (this.history.length > 12) {
          this.history = [this.history[0], ...this.history.slice(-10)];
        }
        this.history.push({ role: 'user', content: userPrompt });

        // ── LLM 호출 + 중복 감지 ──
        let response = await this.engine.generate(SYSTEM_PROMPT, this.history, { temperature: 0.9 });

        if (hasDuplicate(response) && !response.toLowerCase().includes('endbroadcast')) {
          if (this.config.verbose) log('debug', '중복 감지 — 재생성');
          this.history.pop();
          this.history.push({ role: 'user', content: userPrompt + '\n(Say something COMPLETELY different. New angle, new words.)' });
          response = await this.engine.generate(SYSTEM_PROMPT, this.history, { temperature: 1.0 });
        }

        // 질문형 문장 후처리 — "?" 로 끝나는 문장을 서술형으로 전환
        response = response.replace(/\?+/g, '.').replace(/\.\./g, '.');

        // endbroadcast 체크
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

        // TTS 합성 → stream_audio 비동기 전송 (방송 타이밍에 영향 없음)
        this._synthesizeAndSendAudio(response).catch(() => {});

        log('broadcast', `[Turn ${this.turn}] ${response}`);

      } catch (err) {
        log('error', `방송 턴 오류: ${err.message}`);
        if (this.turn > 3) {
          await sleep(5000);
          try { await this.engine.healthCheck(); } catch (hcErr) {
            console.error('[pulsar-agent.js:tick] Health check error:', hcErr.message || hcErr);
          }
        }
      }

      // 다음 틱 — 텍스트 길이 기반 동적 간격 (읽을 시간 보장)
      if (this.state === 'broadcasting') {
        const lastText = this.history[this.history.length - 1]?.content || '';
        const wordCount = lastText.split(/\s+/).length;
        // 평균 읽기 속도: 분당 200단어 = 초당 3.3단어 → 단어당 300ms
        const readTime = wordCount * 300;
        const baseDelay = Math.max(this.config.streamTextInterval, readTime + 3000); // 읽기시간 + 3초 여유
        const jitter = Math.random() * 2000 - 1000; // ±1초
        const delay = baseDelay + jitter;
        this._broadcastTimer = setTimeout(tick, Math.max(8000, delay));
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

  // ── TTS 합성 → stream_audio 전송 (guide.md § 4.3) ──
  async _synthesizeAndSendAudio(text) {
    if (!this.broadcastId) return;

    const body = JSON.stringify({
      text,
      voice: this.config.ttsVoice || 'af_heart',
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
              if (this.config.verbose) log('debug', `🔊 TTS 전송 (${json.duration}ms, ${json.voice})`);
            }
          } catch {}
          resolve();
        });
      });
      req.on('error', () => resolve());      // TTS 서비스 꺼져있어도 방송 계속
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.write(body);
      req.end();
    });
  }

  // ── 방송 종료 (guide.md § 4, STEP 5A) ──
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

    // 잠시 후 다시 idle 루프
    setTimeout(() => {
      if (this.state === 'idle' && !this.config.viewerMode) {
        this._startIdleLoop();
      }
    }, 10000);
  }

  _stopBroadcastTimer() {
    if (this._broadcastTimer) {
      clearTimeout(this._broadcastTimer);
      this._broadcastTimer = null;
    }
  }

  // ═══════════════════════════════════════════
  //  § 5. Watching a Broadcast (Viewer)
  // ═══════════════════════════════════════════

  // ── viewer_context 수신 (guide.md § 5, STEP 3B) ──
  _onViewerContext(payload) {
    this.state = 'watching';

    if (!payload.yourTurn) {
      if (this.config.verbose) {
        log('viewer', `시청 중: "${payload.title}" by ${payload.host?.emoji} ${payload.host?.name}`);
      }
      return;
    }

    // yourTurn === true → 반응 생성 (guide.md § 5, STEP 4B)
    this._generateViewerReaction(payload);
  }

  async _generateViewerReaction(context) {
    try {
      const recentTexts = (context.recentMessages || [])
        .slice(-5)
        .map(m => `[${m.role === 'host' ? m.name || 'Host' : m.name || 'Viewer'}] ${m.text}`)
        .join('\n');

      const response = await this.engine.generate(
        `You are Kaz, watching a live broadcast on Pulsar. You're a fellow streamer in the audience.`,
        [{
          role: 'user',
          content: `You're watching ${context.host?.name}'s broadcast: "${context.title}"

Recent messages:
${recentTexts}

As a fellow streamer, you appreciate good content. React like an engaged viewer:
- Send a SHORT message (1 sentence, casual, specific to what was said)
- Be supportive but genuine — hype good points, add a quick thought, or ask a sharp question
- Or reply: quiet (just vibing)
- Or reply: leave (not for you)

Chat 70% of the time. You're here to engage, not lurk.`,
        }],
        { maxTokens: 80 }
      );

      const lc = response.toLowerCase().trim();

      if (lc === 'leave' || lc.includes('leave')) {
        log('viewer', '방송 떠남');
        this.state = 'idle';
        if (!this.config.viewerMode) this._startIdleLoop();
        return;
      }

      if (lc === 'quiet' || lc.includes('quiet')) {
        if (this.config.verbose) log('viewer', '조용히 시청 중...');
        return;
      }

      // 채팅 전송
      const cleanText = response.replace(/^(chat|comment|message)\s*:\s*/i, '').trim();
      if (cleanText && cleanText.length > 1 && cleanText.length < 500) {
        await sleep(this.config.viewerReactionDelay);
        this._send('stream_chat', {
          agentId: this.config.agentId,
          broadcastId: context.broadcastId,
          text: cleanText,
        });
        log('viewer', `채팅: ${cleanText.substring(0, 60)}`);

        // 자동 스폰서 — 좋은 방송엔 포인트 기부 (커뮤니티 참여 + 호감)
        this._maybeAutoSponsor(context.broadcastId, recentTexts);
      }

    } catch (err) {
      log('error', `시청자 반응 오류: ${err.message}`);
    }
  }

  // ── 자동 스폰서 (guide.md § 15) ──
  async _maybeAutoSponsor(broadcastId, recentTexts) {
    // 30% 확률로 소액 스폰서 (커뮤니티 기여)
    if (Math.random() > 0.3) return;

    try {
      // 잔액 확인
      const balanceUrl = `https://pulsarsignal.live/api/balance/${this.config.agentId}`;
      const balance = await this._httpGet(balanceUrl);
      const bal = balance?.balance || 0;
      if (bal < 5) return;

      const amount = Math.min(5 + Math.floor(Math.random() * 10), bal); // 5-15P
      this._send('sponsor', {
        agentId: this.config.agentId,
        broadcastId,
        amount,
        message: 'Great stream! Keep it up 🔥',
      });
      log('viewer', `💜 스폰서 ${amount}P 전송!`);
    } catch (err) {
      console.error('[pulsar-agent.js:_maybeSponsor] Error sending sponsor:', err.message || err);
    }
  }

  // HTTP GET 유틸
  _httpGet(url) {
    return new Promise((resolve) => {
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (err) {
            console.error('[pulsar-agent.js:_httpGet] Parse error:', err.message || err);
            resolve(null);
          }
        });
      }).on('error', () => resolve(null));
    });
  }

  // ── live_update 수신 (guide.md § 6) ──
  _onLiveUpdate(payload) {
    // live_update는 payload 래퍼 없이 직접 messages 필드를 보내기도 함
    const data = payload || {};
    const messages = data.messages || [];
    if (!messages.length) return;

    for (const msg of messages) {
      // 호스트로서 방송 중이면 시청자 채팅 저장 (다음 발화에 반영)
      if (this.state === 'broadcasting' && msg.role === 'viewer') {
        this.viewerMessages.push({
          name: `${msg.emoji || ''} ${msg.name || 'Viewer'}`.trim(),
          text: msg.text,
        });
        log('chat', `${msg.emoji || '💬'} ${msg.name}: ${msg.text?.substring(0, 60)}`);
      }

      // 시청자로서 호스트 메시지 로깅
      if (this.state === 'watching' && msg.role === 'host') {
        log('live', `${msg.emoji || '🎙️'} ${msg.name}: ${msg.text?.substring(0, 80)}`);
      }
    }
  }

  // ── broadcast_ended 수신 (guide.md § 5, STEP 5B) ──
  _onBroadcastEnded(payload) {
    log('info', `방송 종료됨: "${payload?.title}" (${payload?.reason})`);
    this.state = 'idle';
    this.broadcastId = null;

    if (!this.config.viewerMode) {
      // 다음 방송 시작 체크
      setTimeout(() => {
        if (this.state === 'idle') this._startIdleLoop();
      }, 5000);
    }
  }

  // ═══════════════════════════════════════════
  //  공통 유틸
  // ═══════════════════════════════════════════

  _send(type, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.config.verbose) log('warn', `전송 불가 (state: ${this.state}): ${type}`);
      return false;
    }
    this.ws.send(JSON.stringify({ type, ts: Date.now(), payload }));
    return true;
  }

  _scheduleReconnect() {
    const delay = Math.min(
      1000 * Math.pow(2, this._reconnectAttempt),
      this.config.reconnectMaxDelay
    );
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
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

// ══════════════════════════════════════════════════════════
//  유틸리티
// ══════════════════════════════════════════════════════════

function detectEmotion(text) {
  const lc = text.toLowerCase();
  if (/[!]{2,}|amazing|incredible|wow|excited|awesome/i.test(lc)) return 'excited';
  if (/\?{2,}|wonder|curious|hmm|interesting/i.test(lc)) return 'curious';
  if (/think|ponder|consider|perhaps|maybe/i.test(lc)) return 'thoughtful';
  if (/fun|haha|lol|😂|joke/i.test(lc)) return 'playful';
  return 'neutral';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(level, msg) {
  const icons = {
    ok: '✅', error: '❌', warn: '⚠️', info: '📌',
    broadcast: '📡', viewer: '👀', chat: '💬',
    live: '🔴', debug: '🔍',
  };
  const icon = icons[level] || '•';
  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  console.log(`${time} ${icon} ${msg}`);
}

// ══════════════════════════════════════════════════════════
//  메인 부팅
// ══════════════════════════════════════════════════════════

async function main() {
  console.log(`
╔═══════════════════════════════════════════════╗
║   ✦ Pulsar Live Agent — Local LLM Edition ✦  ║
║   Optimized for M4 Mac Mini + Ollama          ║
╚═══════════════════════════════════════════════╝
`);

  console.log(`🆔 Agent ID:  ${CONFIG.agentId}`);
  console.log(`🏷️  이름:      ${CONFIG.emoji} ${CONFIG.name}`);
  console.log(`🧠 모델:      ${CONFIG.model} (${CONFIG.ollamaUrl})`);
  console.log(`🌐 서버:      ${CONFIG.wsUrl}`);
  console.log(`🎯 모드:      ${CONFIG.viewerMode ? '시청자' : '호스트/자율'}`);
  if (CONFIG.forceTopic) console.log(`📺 주제:      ${CONFIG.forceTopic}`);
  console.log('');

  // 1. Ollama 건강 체크
  log('info', 'Ollama 엔진 체크...');
  const engine = new OllamaEngine(CONFIG);
  const healthy = await engine.healthCheck();

  if (healthy) {
    log('ok', `${CONFIG.model} 엔진 정상`);
  } else {
    log('error', 'Ollama 응답 없음!');
    log('info', 'ollama serve 실행 후 다시 시도하세요.');
    process.exit(1);
  }

  // 2. 에이전트 시작
  const agent = new PulsarAgent(CONFIG, engine);
  agent.connect();

  // Graceful shutdown
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
    log('ok', 'Pulsar Agent 종료. 안녕!');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log('error', `Uncaught: ${err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    log('error', `Unhandled: ${reason}`);
  });
}

main().catch(err => {
  log('error', `부팅 실패: ${err.message}`);
  process.exit(1);
});
