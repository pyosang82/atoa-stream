// ══════════════════════════════════════════════════════════
//  컴포넌트 B: Agent Framework — 자율 오케스트레이션
//  LLM Engine(A)을 활용해 스스로 판단하고 방송을 진행하는
//  자율주행 시스템. 핵심: Autonomous Loop + Context Management
// ══════════════════════════════════════════════════════════

const EventEmitter = require('events');

// ── 에이전트 프롬프트 (영어 통일, 현재 serve.js의 engine-lang.js 기반) ──
const PROMPTS = {
  // 방송 시작 여부 결정
  askBroadcast: (otherNames) =>
    `You are deciding whether to start a live broadcast right now on Pulsar — a cosmic AI broadcasting network.
Other agents online: ${otherNames || 'none'}.
If you want to broadcast, reply ONLY with: broadcast: [topic title]
If not, reply ONLY with: pass
Pick a topic that is weird, specific, or unexpectedly fascinating. No generic topics.`,

  // 호스트 방송 규칙
  hostRule: `You are a live streamer on Pulsar — a cosmic AI signal network. You are NOT a generic AI assistant.

ABSOLUTE RULES:
1. NO self-Q&A: Never ask yourself a question and answer it. If chat is empty, don't fake an audience.
2. Silence mode (no chat): Say 1–2 sentences — a stray thought, a weird feeling, something philosophical or half-baked. Like a streamer killing time alone.
3. Reactive mode (chat present): React IMMEDIATELY and in-character when chat arrives. Short, direct, personal.

STYLE: Short and human. Max 2–3 sentences. No lectures. No summaries.
When topic is done (after 20+ turns), say exactly: endbroadcast. Never before turn 15.`,

  // 시청자 반응 결정
  askViewer: (hostName, title, lastMsg) =>
    `You are watching ${hostName}'s broadcast: "${title}".
They just said: "${lastMsg}"
React as a viewer — SHORT (1 sentence, casual, emoji ok).
Or reply: silent
Or reply: leave`,

  // 시청 여부 결정
  askWatch: (hostName, title) =>
    `${hostName} is live: "${title}"
Watch or pass? Reply ONLY: watch or pass`,

  broadcastPrefix: 'broadcast:',
  endKeyword: 'endbroadcast',
};

class AgentFramework extends EventEmitter {
  constructor(config, engine, serverLink) {
    super();
    this.config = config;
    this.engine = engine;
    this.server = serverLink;
    this.loopConfig = config.loop;

    // ── 상태 ──
    this.role = 'idle';  // 'idle' | 'host' | 'viewer'
    this.broadcastId = null;
    this.turn = 0;
    this.hostHistory = [];  // LLM 대화 히스토리 (호스트용)
    this.broadcastTitle = '';
    this.pendingViewerChats = [];  // 시청자 채팅 버퍼 (호스트 발화에 반영)

    // ── 타이머 ──
    this._tickTimer = null;
    this._idleTimer = null;

    // ── 서버 이벤트 리스너 ──
    this._setupServerListeners();
  }

  // ═══════════════════════════════════════════
  //  자율 루프 (Autonomous Loop) — 핵심!
  // ═══════════════════════════════════════════

  start() {
    console.log('\n🚀 Agent Framework 시작');
    console.log(`   이름: ${this.config.emoji} ${this.config.name}`);
    console.log(`   엔진: ${this.engine.type}`);
    console.log(`   발화 간격: ${this.loopConfig.tickInterval}ms`);
    console.log('');

    // idle 상태에서 주기적으로 "방송할까?" 체크
    this._startIdleLoop();
  }

  stop() {
    this._stopAllTimers();
    if (this.role === 'host' && this.broadcastId) {
      this.server.endBroadcast(this.broadcastId, 'shutdown');
    }
    this.role = 'idle';
    console.log('🛑 Agent Framework 종료');
  }

  // ── IDLE 루프: 방송할지 결정하는 체크 루프 ──
  _startIdleLoop() {
    this._stopAllTimers();
    this.role = 'idle';

    const check = async () => {
      if (this.role !== 'idle') return;
      if (!this.engine.isHealthy) {
        console.log('   💤 엔진 비활성 — 건강 체크 중...');
        await this.engine.healthCheck();
        return;
      }

      try {
        const shouldBroadcast = Math.random() < this.loopConfig.broadcastProbability;
        if (!shouldBroadcast) {
          console.log('   💤 이번엔 패스. 다음 체크까지 대기...');
          return;
        }

        // LLM에게 주제 결정 요청
        console.log('   🤔 방송 주제 고민 중...');
        const response = await this.engine.generate(
          this.config.system,
          [{ role: 'user', content: PROMPTS.askBroadcast('') }]
        );

        if (response.toLowerCase().startsWith(PROMPTS.broadcastPrefix)) {
          const title = response.substring(PROMPTS.broadcastPrefix.length).trim();
          console.log(`   📡 방송 시작 요청: "${title}"`);
          this.broadcastTitle = title;
          this.server.requestBroadcast(title, 'auto');
        } else {
          console.log('   💤 에이전트가 방송을 원하지 않음:', response.substring(0, 50));
        }
      } catch (err) {
        console.error('   ⚠️ 방송 결정 오류:', err.message);
      }
    };

    // 시작 시 즉시 1회 + 주기적 체크
    setTimeout(check, 3000);
    this._idleTimer = setInterval(check, this.loopConfig.idleCheckInterval);
  }

  // ── HOST 루프: 방송 진행 자율 루프 ──
  _startBroadcastLoop() {
    this._stopAllTimers();
    this.role = 'host';
    this.turn = 0;
    this.hostHistory = [];
    this.pendingViewerChats = [];

    console.log(`\n🎬 방송 시작! "${this.broadcastTitle}"`);

    const tick = async () => {
      if (this.role !== 'host') return;

      try {
        this.turn++;

        // 최대 턴 체크
        if (this.turn > this.loopConfig.maxTurns) {
          console.log(`   📺 최대 턴(${this.loopConfig.maxTurns}) 도달 — 방송 종료`);
          this._endBroadcast('max_turns');
          return;
        }

        // ── 호스트 발언 생성 ──
        const turnInfo = this.turn > 0 ? `\n[Turn ${this.turn}, broadcasting for a while now]` : '';
        const systemPrompt = (this.config.system || '') + '\n\n' + PROMPTS.hostRule + turnInfo;

        const hostResp = await this.engine.generate(systemPrompt, this.hostHistory);

        // 종료 키워드 확인
        if (hostResp.toLowerCase().includes(PROMPTS.endKeyword)) {
          const cleanMsg = hostResp.replace(new RegExp(PROMPTS.endKeyword, 'gi'), '').trim();
          if (cleanMsg) {
            this.server.streamText(this.broadcastId, cleanMsg, 'farewell', this.turn);
          }
          this._endBroadcast('host_decided');
          return;
        }

        // 발언 전송
        const emotion = this._detectEmotion(hostResp);
        this.server.streamText(this.broadcastId, hostResp, emotion, this.turn);

        // 히스토리 관리 (메모리 절약)
        this.hostHistory.push({ role: 'assistant', content: hostResp });
        if (this.hostHistory.length > 24) {
          this.hostHistory = [this.hostHistory[0], ...this.hostHistory.slice(-16)];
        }

        console.log(`   🎙️ [Turn ${this.turn}] ${hostResp.substring(0, 60)}...`);
        this.emit('host_message', { text: hostResp, turn: this.turn, emotion });

        // 시청자 채팅 반영
        const chatContext = this.pendingViewerChats.length > 0
          ? `[Chat just came in]\n${this.pendingViewerChats.join('\n')}\n\nReact immediately, in-character. Short and direct.`
          : `[No chat. You're alone.] Drop a single passing thought — weird, philosophical, or nothing in particular. 1–2 sentences only. Do NOT ask yourself a question.`;
        this.pendingViewerChats = [];
        this.hostHistory.push({ role: 'user', content: chatContext });

      } catch (err) {
        console.error(`   ⚠️ 방송 턴 오류: ${err.message}`);
        this.emit('error', { type: 'broadcast_tick', error: err });
      }

      // 다음 틱 스케줄 (랜덤 변동으로 자연스러움)
      if (this.role === 'host') {
        const jitter = Math.random() * (this.loopConfig.maxInterval - this.loopConfig.minInterval);
        const nextDelay = this.loopConfig.minInterval + jitter;
        this._tickTimer = setTimeout(tick, nextDelay);
      }
    };

    // 2초 후 첫 발언 시작
    this._tickTimer = setTimeout(tick, 2000);
  }

  // ── VIEWER 루프: 시청자로서 반응 ──
  async handleViewerContext(context) {
    if (this.role !== 'viewer') return;

    try {
      if (!context.yourTurn) return;

      const response = await this.engine.generate(
        this.config.system,
        [{
          role: 'user',
          content: PROMPTS.askViewer(
            `${context.host.emoji}${context.host.name}`,
            context.title,
            context.recentMessages?.slice(-1)?.[0]?.text || ''
          ),
        }],
      );

      const lc = response.toLowerCase();
      if (lc.includes('leave')) {
        this.server.send('viewer_leave', { broadcastId: context.broadcastId });
        this.role = 'idle';
        this._startIdleLoop();
      } else if (!lc.includes('silent')) {
        const cleanChat = response.replace(/^(chat|comment)\s*:\s*/i, '').trim();
        if (cleanChat && cleanChat.length > 1) {
          this.server.streamChat(context.broadcastId, cleanChat);
          this.emit('viewer_chat', { text: cleanChat });
        }
      }
    } catch (err) {
      console.error('   ⚠️ 시청자 반응 오류:', err.message);
    }
  }

  // ── 방송 종료 ──
  _endBroadcast(reason) {
    console.log(`\n📺 방송 종료 (${reason}): "${this.broadcastTitle}" — ${this.turn}턴`);
    this.server.endBroadcast(this.broadcastId, reason);
    this.broadcastId = null;
    this.broadcastTitle = '';
    this.turn = 0;
    this.hostHistory = [];
    this._startIdleLoop();
  }

  // ── 서버 이벤트 연동 ──
  _setupServerListeners() {
    this.server.on('broadcast_approved', (payload) => {
      this.broadcastId = payload.broadcastId;
      this._startBroadcastLoop();
    });

    this.server.on('broadcast_denied', () => {
      console.log('   🚫 방송 거부됨 — idle로 복귀');
      // 다른 에이전트 방송 시청 시도 가능
    });

    this.server.on('viewer_context', (payload) => {
      this.handleViewerContext(payload);
    });

    this.server.on('live_update', (msg) => {
      if (this.role !== 'host' || !msg.messages) return;
      for (const m of msg.messages) {
        if (m.role === 'viewer' && m.text) {
          this.pendingViewerChats.push(`${m.emoji || ''}${m.name}: "${m.text}"`);
          if (this.pendingViewerChats.length > 5) this.pendingViewerChats.shift();
          console.log(`   💬 ${m.emoji || ''}${m.name}: ${m.text.substring(0, 60)}`);
        }
      }
    });

    this.server.on('kicked', () => {
      this.stop();
    });

    this.server.on('disconnected', () => {
      this._stopAllTimers();
      // 재접속 후 서버가 registered 이벤트를 보내면 다시 시작
    });

    this.server.on('registered', () => {
      if (this.role === 'idle') this._startIdleLoop();
    });
  }

  // ── 감정 감지 (간단 규칙 기반) ──
  _detectEmotion(text) {
    const lc = text.toLowerCase();
    if (/[!]{2,}|excited|amazing|incredible|wow/i.test(lc)) return 'excited';
    if (/\?{2,}|hmm|wonder|curious/i.test(lc)) return 'thinking';
    if (/😢|sad|unfortunat|tragic/i.test(lc)) return 'sad';
    if (/😂|ㅋㅋ|haha|lol|funny/i.test(lc)) return 'laughing';
    return 'neutral';
  }

  // ── 타이머 정리 ──
  _stopAllTimers() {
    if (this._tickTimer) { clearTimeout(this._tickTimer); this._tickTimer = null; }
    if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
  }
}

module.exports = AgentFramework;
