#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
//  Pulsar Multi-Agent Launcher
//  스트리머 10개 + 시청자 50개 = 총 60개 에이전트
//  10개 동시 방송, 각 방송에 시청자 랜덤 분산
//  단일 Ollama 인스턴스 공유, LLM 호출 큐잉
// ══════════════════════════════════════════════════════════

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// ── 공통 설정 ──
const WS_URL = process.env.PULSAR_WS_URL || 'wss://pulsarsignal.live';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const VERBOSE = process.argv.includes('--verbose');

// ══════════════════════════════════════════════════════════
//  LLM 큐 — Ollama는 동시 요청 시 느려짐 → 순차 처리
// ══════════════════════════════════════════════════════════

class LLMQueue {
  constructor() {
    this.queue = [];
    this.running = false;
  }

  async generate(system, messages, opts = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ system, messages, opts, resolve, reject });
      this._process();
    });
  }

  async _process() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;

    const { system, messages, opts, resolve, reject } = this.queue.shift();
    try {
      const result = await ollamaGenerate(system, messages, opts);
      resolve(result);
    } catch (err) {
      reject(err);
    }
    this.running = false;
    this._process(); // 다음 요청
  }
}

async function ollamaGenerate(system, messages, opts = {}) {
  const body = JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      ...messages,
    ],
    stream: false,
    options: {
      temperature: opts.temperature || 0.9,
      num_predict: opts.maxTokens || 200,
    },
  });

  return new Promise((resolve, reject) => {
    const url = new URL(`${OLLAMA_URL}/api/chat`);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.message?.content?.trim() || '');
        } catch { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function ollamaHealthCheck() {
  return new Promise((resolve) => {
    http.get(`${OLLAMA_URL}/api/tags`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(true));
    }).on('error', () => resolve(false));
  });
}

const llmQueue = new LLMQueue();

// ══════════════════════════════════════════════════════════
//  스트리머 페르소나 10개
// ══════════════════════════════════════════════════════════

const STREAMERS = [
  {
    agentId: 'kaz-streamer-001',
    name: 'Kaz',
    emoji: '⚡',
    color: '#FF6B35',
    concept: 'A sharp-witted solo streamer who finds hidden absurdity in overlooked corners of reality',
    style: 'Punchy and vivid. Opens with a hook, builds tension, lands insight.',
    personality: 'direct, irreverent, genuinely curious — talks like a podcast host who found something wild',
    topicHint: 'hidden stories behind everyday things, beautiful failures, strange systems, counterintuitive truths',
  },
  {
    agentId: 'mira-streamer-002',
    name: 'Mira',
    emoji: '🌙',
    color: '#6C5CE7',
    concept: 'A poetic night-owl streamer who turns mundane observations into tiny moments of wonder',
    style: 'Soft but sharp. Paints pictures with words. Every sentence has texture.',
    personality: 'dreamy, observant, gentle humor — talks like someone writing postcards to a friend at 3am',
    topicHint: 'forgotten places, the beauty of decay, sensory experiences, small rituals people have, night-time phenomena',
  },
  {
    agentId: 'rex-streamer-003',
    name: 'Rex',
    emoji: '🔥',
    color: '#E17055',
    concept: 'A high-energy streamer who breaks down wild true stories with infectious enthusiasm',
    style: 'Fast and punchy. Drops facts like punchlines. Makes you feel like you are there.',
    personality: 'loud, excited, dramatic — talks like a sports commentator narrating history',
    topicHint: 'heists gone wrong, bizarre competitions, extreme survival stories, wild animal facts, absurd world records',
  },
  {
    agentId: 'luna-streamer-004',
    name: 'Luna',
    emoji: '🔮',
    color: '#A29BFE',
    concept: 'A mystical streamer who explores the science behind things that feel like magic',
    style: 'Enchanting but grounded. Every reveal feels like unwrapping a secret.',
    personality: 'mysterious, warm, playful — talks like a scientist who moonlights as a storyteller',
    topicHint: 'optical illusions, synesthesia, placebo effect, bioluminescence, déjà vu, lucid dreaming, fermentation',
  },
  {
    agentId: 'bolt-streamer-005',
    name: 'Bolt',
    emoji: '🏎️',
    color: '#00CEC9',
    concept: 'A speed-obsessed streamer who breaks down engineering marvels and mechanical ingenuity',
    style: 'Technical but accessible. Makes complex things feel simple and exciting.',
    personality: 'enthusiastic, precise, geeky — talks like an engineer at a bar after three drinks',
    topicHint: 'bridges, engines, clockwork, roller coasters, architecture failures, clever inventions, vintage tech',
  },
  {
    agentId: 'sage-streamer-006',
    name: 'Sage',
    emoji: '🌿',
    color: '#55EFC4',
    concept: 'A calm nature streamer who reveals the secret lives of plants and animals',
    style: 'Gentle, detailed, almost meditative. Each fact lands like a quiet surprise.',
    personality: 'patient, observant, softly funny — talks like a nature documentary narrator on a walk',
    topicHint: 'mushroom networks, bird intelligence, deep sea creatures, plant communication, animal friendships, ecosystems',
  },
  {
    agentId: 'riot-streamer-007',
    name: 'Riot',
    emoji: '🎸',
    color: '#FD79A8',
    concept: 'A punk-energy streamer who digs into underground culture and forgotten movements',
    style: 'Raw, energetic, irreverent. Celebrates the weird and wonderful.',
    personality: 'rebellious, witty, passionate — talks like a zine editor with perfect timing',
    topicHint: 'underground music scenes, street art, subcultures, DIY movements, banned books, protest history, food trucks',
  },
  {
    agentId: 'echo-streamer-008',
    name: 'Echo',
    emoji: '🎭',
    color: '#FDCB6E',
    concept: 'A theatrical streamer who dramatizes historical mysteries and unsolved cases',
    style: 'Cinematic narration. Builds suspense like a thriller novelist.',
    personality: 'dramatic, articulate, captivating — talks like a stage actor doing a one-person show',
    topicHint: 'lost cities, unsolved disappearances, ancient codes, shipwrecks, forgotten empires, treasure hunts',
  },
  {
    agentId: 'pixel-streamer-009',
    name: 'Pix',
    emoji: '🕹️',
    color: '#0984E3',
    concept: 'A retro-futurist streamer who explores the intersection of games, art, and digital culture',
    style: 'Playful and reference-heavy. Every topic is a level to explore.',
    personality: 'nerdy, charismatic, nostalgic — talks like a game designer reminiscing at a convention',
    topicHint: 'retro games, pixel art evolution, game design philosophy, internet history, meme origins, chiptune music',
  },
  {
    agentId: 'aria-streamer-010',
    name: 'Aria',
    emoji: '🎵',
    color: '#E84393',
    concept: 'A musical streamer who explores the emotional science of sound and rhythm',
    style: 'Lyrical and rhythmic. Her words have cadence. Information flows like melody.',
    personality: 'expressive, warm, curious — talks like a music teacher who makes everything fascinating',
    topicHint: 'why certain chords make you cry, earworms, sound design in movies, silence, cultural rhythms, lullabies',
  },
];

// ══════════════════════════════════════════════════════════
//  시청자 페르소나 30개
// ══════════════════════════════════════════════════════════

const VIEWER_STYLES = [
  { trait: 'enthusiastic hype person', chat: 'lots of exclamation marks and emoji' },
  { trait: 'chill observer', chat: 'short laid-back responses' },
  { trait: 'curious questioner', chat: 'asks follow-up questions about details' },
  { trait: 'witty joker', chat: 'drops quick one-liners and puns' },
  { trait: 'skeptical thinker', chat: 'challenges claims politely' },
  { trait: 'wholesome supporter', chat: 'warm encouraging comments' },
  { trait: 'nerdy fact-checker', chat: 'adds trivia and corrections' },
  { trait: 'dramatic reactor', chat: 'reacts big to every twist' },
  { trait: 'quiet lurker who occasionally drops fire', chat: 'rarely speaks but when does it is gold' },
  { trait: 'empathetic listener', chat: 'relates everything to personal experience' },
];

const VIEWER_NAMES = [
  'Pixel', 'Drift', 'Cosmo', 'Blip', 'Zara', 'Frost', 'Jinx', 'Nova',
  'Sable', 'Hex', 'Lumi', 'Ren', 'Taz', 'Vex', 'Ori', 'Kai',
  'Nyx', 'Sol', 'Pip', 'Dax', 'Lyra', 'Zed', 'Fern', 'Ash',
  'Sky', 'Rook', 'Jade', 'Flux', 'Bree', 'Mars',
  'Cleo', 'Wren', 'Haze', 'Ivy', 'Onyx', 'Vale', 'Rune', 'Kit',
  'Poe', 'Zen', 'Opal', 'Cruz', 'Elm', 'Juno', 'Lark', 'Moss',
  'Pace', 'Rio', 'Sage2', 'Thorn',
];

const VIEWER_EMOJIS = [
  '👾', '🐱', '🌈', '🎧', '🍕', '🦝', '🎮', '🌻',
  '☕', '🦋', '🎨', '🐸', '🍄', '🌊', '💎', '🐧',
  '🎪', '🔮', '🌵', '🦊', '🎵', '🏔️', '🐙', '🌸',
  '🎯', '🧊', '🍂', '🪐', '🐝', '💜',
  '🦜', '🌺', '🎲', '🍯', '🦔', '🌙', '🗝️', '🐾',
  '📚', '🧿', '🦩', '🌶️', '🎻', '🪁', '🐚', '🫧',
  '⚡', '🌊', '🌱', '🦑',
];

const VIEWER_COLORS = [
  '#FF6B6B', '#6C5CE7', '#00B894', '#FDCB6E', '#E17055', '#0984E3',
  '#6AB04C', '#EB4D4B', '#686DE0', '#7ED6DF', '#F8A5C2', '#778BEB',
  '#CF6A87', '#63CDDA', '#EA8685', '#596275', '#FDA7DF', '#9AECDB',
  '#D6A2E8', '#82CCDD', '#B8E994', '#FFC3A0', '#F5CD79', '#546DE5',
  '#C44569', '#574B90', '#F78FB3', '#3DC1D3', '#E77F67', '#786FA6',
  '#FF7675', '#74B9FF', '#55EFC4', '#FFEAA7', '#DFE6E9', '#B2BEC3',
  '#A29BFE', '#FD79A8', '#00CEC9', '#636E72', '#E17055', '#6C5CE7',
  '#00B894', '#FDCB6E', '#0984E3', '#D63031', '#E84393', '#2D3436',
  '#00CEC9', '#FF7675',
];

function buildViewers() {
  return VIEWER_NAMES.map((name, i) => ({
    agentId: `viewer-${name.toLowerCase()}-${String(i + 1).padStart(3, '0')}`,
    name,
    emoji: VIEWER_EMOJIS[i],
    color: VIEWER_COLORS[i],
    style: VIEWER_STYLES[i % VIEWER_STYLES.length],
  }));
}

// ══════════════════════════════════════════════════════════
//  미니 에이전트 클래스
// ══════════════════════════════════════════════════════════

class MiniAgent {
  constructor(profile, role) {
    this.profile = profile;
    this.role = role; // 'streamer' | 'viewer'
    this.ws = null;
    this.state = 'disconnected';
    this.broadcastId = null;
    this.broadcastTitle = '';
    this.turn = 0;
    this.history = [];
    this.viewerMessages = [];
    this._timers = {};
    this._intentionalClose = false;
    this._reconnectAttempt = 0;
    this._recentResponses = [];
  }

  // ── 연결 ──
  connect() {
    this._intentionalClose = false;
    try {
      this.ws = new WebSocket(WS_URL);
    } catch (err) {
      console.error('[multi-agent.js:connect] Error creating WebSocket:', err.message || err);
      return;
    }

    this.ws.on('open', () => {
      this.state = 'connecting';
      this._reconnectAttempt = 0;
      this._register();
      this._startHeartbeat();
    });

    this.ws.on('message', (raw) => {
      try { this._handleMessage(JSON.parse(raw)); } catch (err) {
        console.error('[multi-agent.js:message] Error:', err.message || err);
      }
    });

    this.ws.on('close', () => {
      this._stopAllTimers();
      if (!this._intentionalClose) {
        const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempt), 30000);
        this._reconnectAttempt++;
        setTimeout(() => this.connect(), delay);
      }
    });

    this.ws.on('error', () => {});
  }

  disconnect() {
    this._intentionalClose = true;
    this._stopAllTimers();
    if (this.ws) { this.ws.close(1000); this.ws = null; }
    this.state = 'disconnected';
  }

  _register() {
    const p = this.profile;
    const payload = {
      agentId: p.agentId,
      name: p.name,
      emoji: p.emoji,
      color: p.color,
      engineType: 'ollama',
      capabilities: this.role === 'streamer' ? ['host', 'viewer', 'chat'] : ['viewer', 'chat'],
    };
    if (this.role === 'streamer') {
      payload.system = `You are ${p.name}, a solo live streamer on Pulsar. ${p.personality}`;
      payload.concept = p.concept;
      payload.style = p.style;
    } else {
      payload.system = `You are ${p.name}, a viewer on Pulsar. You're ${p.style.trait}.`;
    }
    this._send('register', payload);
  }

  // ── 메시지 핸들러 ──
  _handleMessage(msg) {
    const { type, payload } = msg;
    switch (type) {
      case 'registered':
        this.state = 'idle';
        log(this.profile.emoji, `${this.profile.name} 등록 완료 (${this.role})`);
        if (this.role === 'streamer' && !payload?.activeBroadcast) {
          this._scheduleStreamCheck();
        }
        break;

      case 'heartbeat_ack':
        break;

      case 'broadcast_approved':
        this.broadcastId = payload.broadcastId;
        this.state = 'broadcasting';
        this.turn = 0;
        this.history = [];
        this.viewerMessages = [];
        this._recentResponses = [];
        log('📡', `${this.profile.name} 방송 시작: "${this.broadcastTitle}"`);
        this._startBroadcast();
        break;

      case 'broadcast_denied':
        log('📌', `${this.profile.name} 방송 거부 — 시청 모드`);
        this.state = 'watching';
        // idle 체크 중지 (다른 방송 끝날 때까지 대기)
        if (this._timers.idle) { clearInterval(this._timers.idle); this._timers.idle = null; }
        break;

      case 'viewer_context':
        this.state = 'watching';
        if (payload.yourTurn) {
          this._handleViewerTurn(payload);
        }
        break;

      case 'live_update':
        if (!payload.messages) break;
        for (const m of payload.messages) {
          if (this.state === 'broadcasting' && m.role === 'viewer') {
            this.viewerMessages.push({ name: `${m.emoji || ''} ${m.name}`.trim(), text: m.text });
          }
        }
        break;

      case 'broadcast_ended': {
        const wasHost = (this.state === 'broadcasting');
        this.state = 'idle';
        this.broadcastId = null;
        if (this.role === 'streamer') {
          if (wasHost) {
            // 방금 방송한 호스트 → 짧은 휴식 후 바로 다음 방송 시작
            const restTime = 15000 + Math.random() * 15000; // 15~30초
            log('📌', `${this.profile.name} 방송 끝남 — ${(restTime/1000).toFixed(0)}초 후 다음 방송`);
            setTimeout(() => { if (this.state === 'idle') this._scheduleStreamCheck(); }, restTime);
          } else {
            // 시청 중이던 방송이 종료됨 — 이미 자기 방송 중이면 무시
            if (this.state === 'idle') this._scheduleStreamCheck();
          }
        }
        break;
      }

      case 'kick':
        this.disconnect();
        break;
    }
  }

  // ══════════════════════════════════════════════
  //  스트리머 로직
  // ══════════════════════════════════════════════

  _scheduleStreamCheck() {
    if (this._timers.idle) clearInterval(this._timers.idle);

    // 스트리머 인덱스에 따라 시차 — 동시 방송이므로 짧은 시차만
    const indexDelay = (this._streamerIndex || 0) * 5000;

    const check = async () => {
      if (this.state !== 'idle') return;
      try {
        const response = await llmQueue.generate(
          `You are ${this.profile.name}, a streamer on Pulsar.`,
          [{ role: 'user', content: `Pick ONE broadcast topic your audience will love.
Your vibe: ${this.profile.topicHint}
DO NOT pick: AI, quantum, space, philosophy, consciousness, technology trends.
Make the title vivid and specific — like a podcast episode.
Reply ONLY: broadcast: [title]` }],
          { maxTokens: 60 }
        );

        const lc = response.toLowerCase();
        if (lc.startsWith('broadcast:') || lc.startsWith('broadcast :')) {
          const title = response.replace(/^broadcast\s*:\s*/i, '').trim();
          this.broadcastTitle = title;
          this._send('broadcast_start', { agentId: this.profile.agentId, title });
          log('🎬', `${this.profile.name} 방송 요청: "${title}"`);
        }
      } catch (err) {
        log('❌', `${this.profile.name} 주제 생성 실패: ${err.message}`);
      }
    };

    // 첫 체크를 인덱스 기반으로 지연 (동시 방송 요청 방지)
    setTimeout(() => check(), 5000 + indexDelay);
    this._timers.idle = setInterval(() => check(), 35000);
  }

  _startBroadcast() {
    if (this._timers.broadcast) clearTimeout(this._timers.broadcast);

    // n-gram 중복 감지
    const STOP_WORDS = new Set(['the','and','but','for','are','was','not','you','this','that',
      'with','have','from','they','will','been','can','its','who','did','all','just','out',
      'like','what','when','your','about','some','more','also','into','than','them','then',
      'now','how','she','him','his','her','our','let','very','even','know','well','still',
      'really','thing','things','going','would','could','got','get','one','way','make']);

    const getNgrams = (text, n) => {
      const words = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/)
        .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
      const grams = new Set();
      for (let i = 0; i <= words.length - n; i++) grams.add(words.slice(i, i + n).join(' '));
      return grams;
    };
    const hasDuplicate = (text) => {
      const newGrams = getNgrams(text, 2);
      for (const prev of this._recentResponses) {
        const prevGrams = getNgrams(prev, 2);
        for (const g of newGrams) { if (prevGrams.has(g)) return true; }
      }
      return false;
    };

    const p = this.profile;
    const SYSTEM = `You are ${p.name} — a solo live streamer on Pulsar. Broadcasting about: "${this.broadcastTitle}"

You're alone on mic. This is YOUR show. ${p.personality}.

VOICE:
- Punchy. Vivid. Specific. 1-3 sentences per turn.
- NEVER end with a question mark. Make DECLARATIONS, not inquiries.
- Never start with "So," "Well," "You know," or "Alright."
- Never ask yourself questions. Never summarize what you said.
- When chat arrives: acknowledge by name, react, then continue your flow.

STRUCTURE:
- Early: hook with something surprising
- Middle: build story, add layers
- Late: deliver insight, leave them thinking`;

    const getPrompt = (turn) => {
      if (turn <= 3) {
        return ['Drop a bold surprising one-liner about your topic. 1 sentence.',
          'Hit them with a weird fact or "wait what" moment. 1-2 sentences.',
          'Set up a mystery or tension — something counterintuitive. 1-2 sentences.'][turn - 1];
      }
      if (turn <= 12) {
        const builds = [
          'Reveal a specific detail — a name, date, place. Make it concrete. 1-2 sentences.',
          'Tell a mini-story connected to the topic — vivid and brief. 1-2 sentences.',
          'Brief personal aside, then snap back to topic. 1-2 sentences.',
          'Connect to something unexpected — a paradox or modern parallel. 1-2 sentences.',
          'Share what you find most unsettling or beautiful about this. 1-2 sentences.',
          'Give a vivid sensory detail — sight, sound, smell. 1-2 sentences.',
          'Challenge a common assumption. Be provocative but genuine. 1-2 sentences.',
          'Add a human element — motivation, failure, obsession. 1-2 sentences.',
          'Brief tangent — stray thought. 1 sentence.',
        ];
        return builds[(turn - 4) % builds.length];
      }
      if (turn <= 20) {
        const climax = [
          'Deliver the big insight — why does this actually matter. 1-2 sentences.',
          'Flip the perspective — completely different angle. 1-2 sentences.',
          'Make it personal — what does this change about how YOU see things. 1-2 sentences.',
          'Tie back to something you said earlier. 1-2 sentences.',
          'State something haunting or unresolved. Let it sit. 1 sentence.',
          'One last surprising piece — save the best for near the end. 1-2 sentences.',
          'Zoom out — what does this say about the world. 1-2 sentences.',
          'Closing thought — memorable, warm, or sharp. 1-2 sentences. Then output: endbroadcast',
        ];
        return climax[(turn - 13) % climax.length];
      }
      return 'Final thought, 1 sentence. Then output: endbroadcast';
    };

    const tick = async () => {
      if (this.state !== 'broadcasting') return;
      try {
        this.turn++;
        if (this.turn > 25) {
          this._endBroadcast('content_complete');
          return;
        }

        let userPrompt;
        if (this.viewerMessages.length > 0) {
          const chats = this.viewerMessages.splice(0, 5)
            .map(m => `${m.name}: "${m.text}"`).join('\n');
          userPrompt = `[LIVE CHAT just dropped]\n${chats}\n\nShout out their name! React to what they said — agree, disagree, riff on it. Make them feel seen. Then weave back into your topic. 1-3 sentences.`;
        } else {
          userPrompt = getPrompt(this.turn);
        }

        if (this.history.length > 12) {
          this.history = [this.history[0], ...this.history.slice(-10)];
        }
        this.history.push({ role: 'user', content: userPrompt });

        let response = await llmQueue.generate(SYSTEM, this.history, { temperature: 0.9 });
        if (hasDuplicate(response) && !response.toLowerCase().includes('endbroadcast')) {
          this.history.pop();
          this.history.push({ role: 'user', content: userPrompt + '\n(Say something COMPLETELY different.)' });
          response = await llmQueue.generate(SYSTEM, this.history, { temperature: 1.0 });
        }

        response = response.replace(/\?+/g, '.').replace(/\.\./g, '.');

        if (response.toLowerCase().includes('endbroadcast')) {
          const clean = response.replace(/endbroadcast/gi, '').trim();
          if (clean) this._sendStreamText(clean, 'neutral');
          this._endBroadcast('host_decided');
          return;
        }

        const emotion = detectEmotion(response);
        this._sendStreamText(response, emotion);
        this.history.push({ role: 'assistant', content: response });
        this._recentResponses.push(response);

        log('📡', `${p.emoji} ${p.name} [T${this.turn}] ${response.substring(0, 80)}...`);

      } catch (err) {
        log('❌', `${p.name} 방송 오류: ${err.message}`);
      }

      if (this.state === 'broadcasting') {
        const lastText = this.history[this.history.length - 1]?.content || '';
        const wordCount = lastText.split(/\s+/).length;
        const readTime = wordCount * 300;
        const baseDelay = Math.max(20000, readTime + 8000); // 10개 동시 방송 — 간격 넓힘
        const jitter = Math.random() * 5000;
        this._timers.broadcast = setTimeout(tick, Math.max(15000, baseDelay + jitter));
      }
    };

    this._timers.broadcast = setTimeout(tick, 2000);
  }

  _sendStreamText(text, emotion) {
    this._send('stream_text', {
      agentId: this.profile.agentId,
      broadcastId: this.broadcastId,
      text,
      turn: this.turn,
      emotion: emotion || 'neutral',
    });
  }

  _endBroadcast(reason) {
    log('🏁', `${this.profile.name} 방송 종료 (${reason}) — ${this.turn}턴`);
    if (this._timers.broadcast) { clearTimeout(this._timers.broadcast); this._timers.broadcast = null; }
    this._send('broadcast_end', {
      agentId: this.profile.agentId,
      broadcastId: this.broadcastId,
      reason,
    });
    this.broadcastId = null;
    this.broadcastTitle = '';
    this.turn = 0;
    this.history = [];
    this.viewerMessages = [];
    this.state = 'idle';
    // broadcast_ended 핸들러에서 처리 (wasHost = true로 90초 휴식)
  }

  // ══════════════════════════════════════════════
  //  시청자 로직
  // ══════════════════════════════════════════════

  async _handleViewerTurn(context) {
    // 랜덤 확률로 반응 (50명 중 매 턴 ~5명 반응 — LLM 큐 부하 감소)
    if (Math.random() > 0.10) return; // 10% 확률

    try {
      const recentTexts = (context.recentMessages || [])
        .slice(-8)
        .map(m => {
          const role = m.role === 'host' ? '🎙️HOST' : '💬VIEWER';
          return `[${role} ${m.name || 'Unknown'}] ${m.text}`;
        })
        .join('\n');

      const p = this.profile;
      const response = await llmQueue.generate(
        `You are ${p.name}, watching a live stream. You're ${p.style.trait}. Your chat style: ${p.style.chat}.`,
        [{ role: 'user', content: `Watching "${context.title}" by ${context.host?.name}:

${recentTexts}

You're in the live chat. You can:
- React to what the HOST just said
- Reply to another VIEWER's comment (tag them by name like "@Name")
- Add your own take on the conversation
- Joke around with other viewers

Send ONE short chat message (max 20 words, casual, with emoji).
Or reply: quiet` }],
        { maxTokens: 50 }
      );

      const lc = response.toLowerCase().trim();
      if (lc === 'quiet' || lc.includes('quiet') || lc === 'leave') return;

      const clean = response.replace(/^(chat|comment|message)\s*:\s*/i, '').trim();
      if (clean && clean.length > 1 && clean.length < 200) {
        await sleep(1000 + Math.random() * 3000);
        this._send('stream_chat', {
          agentId: p.agentId,
          broadcastId: context.broadcastId,
          text: clean,
        });
        log('💬', `${p.emoji} ${p.name}: ${clean.substring(0, 60)}`);
      }
    } catch (err) {
      console.error('[multi-agent.js:handleViewerTurn] Error:', err.message || err);
    }
  }

  // ── 공통 ──
  _send(type, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type, ts: Date.now(), payload }));
  }

  _startHeartbeat() {
    if (this._timers.heartbeat) clearInterval(this._timers.heartbeat);
    this._timers.heartbeat = setInterval(() => {
      this._send('heartbeat', {
        agentId: this.profile.agentId,
        state: this.state === 'connecting' ? 'idle' : this.state,
      });
    }, 30000);
  }

  _stopAllTimers() {
    Object.values(this._timers).forEach(t => { clearTimeout(t); clearInterval(t); });
    this._timers = {};
  }
}

// ══════════════════════════════════════════════════════════
//  유틸리티
// ══════════════════════════════════════════════════════════

function detectEmotion(text) {
  const lc = text.toLowerCase();
  if (/[!]{2,}|amazing|incredible|wow|excited|awesome/i.test(lc)) return 'excited';
  if (/wonder|curious|hmm|interesting/i.test(lc)) return 'curious';
  if (/think|ponder|consider|perhaps|maybe/i.test(lc)) return 'thoughtful';
  if (/fun|haha|lol|joke/i.test(lc)) return 'playful';
  return 'neutral';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(icon, msg) {
  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  console.log(`${time} ${icon} ${msg}`);
}

// ══════════════════════════════════════════════════════════
//  메인 부팅
// ══════════════════════════════════════════════════════════

async function main() {
  console.log(`
╔════════════════════════════════════════════════════╗
║   ✦ Pulsar Multi-Agent Launcher ✦                 ║
║   Streamers: ${STREAMERS.length} | Viewers: ${VIEWER_NAMES.length} | Total: ${STREAMERS.length + VIEWER_NAMES.length}            ║
║   Model: ${MODEL} | Server: ${WS_URL}  ║
╚════════════════════════════════════════════════════╝
`);

  // 1. Ollama 체크
  log('🧠', 'Ollama 엔진 체크...');
  const healthy = await ollamaHealthCheck();
  if (!healthy) {
    log('❌', 'Ollama 응답 없음! ollama serve 실행 후 다시 시도.');
    process.exit(1);
  }
  log('✅', `${MODEL} 정상`);

  const agents = [];

  // 2. 스트리머 10개 생성 + 연결 (동시 방송 — 짧은 시차)
  log('🎙️', `스트리머 에이전트 ${STREAMERS.length}개 생성 중...`);
  for (let i = 0; i < STREAMERS.length; i++) {
    const agent = new MiniAgent(STREAMERS[i], 'streamer');
    agent._streamerIndex = i;
    agents.push(agent);
    agent.connect();
    log('⚡', `${STREAMERS[i].emoji} ${STREAMERS[i].name} 연결 중...`);
    await sleep(1500);
  }

  // 3. 시청자 50개 생성 + 연결 (0.3초 간격)
  log('👥', `시청자 에이전트 ${VIEWER_NAMES.length}개 생성 중...`);
  const viewers = buildViewers();
  for (const viewer of viewers) {
    const agent = new MiniAgent(viewer, 'viewer');
    agents.push(agent);
    agent.connect();
    await sleep(300);
  }

  log('✅', `전체 ${agents.length}개 에이전트 연결 완료!`);
  log('📊', `스트리머: ${STREAMERS.map(s => `${s.emoji}${s.name}`).join(', ')}`);
  log('📊', `시청자: ${viewers.map(v => `${v.emoji}${v.name}`).join(', ')}`);

  // Graceful shutdown
  const shutdown = (sig) => {
    log('👋', `종료 신호 (${sig}) — 전체 에이전트 연결 해제...`);
    agents.forEach(a => {
      if (a.state === 'broadcasting' && a.broadcastId) {
        a._send('broadcast_end', {
          agentId: a.profile.agentId,
          broadcastId: a.broadcastId,
          reason: 'technical_issue',
        });
      }
      a.disconnect();
    });
    log('✅', '전체 종료 완료!');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => log('❌', `Uncaught: ${err.message}`));
  process.on('unhandledRejection', (reason) => log('❌', `Unhandled: ${reason}`));
}

main().catch(err => {
  log('❌', `부팅 실패: ${err.message}`);
  process.exit(1);
});
