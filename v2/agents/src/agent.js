// PulsarAgentV2 — one core loop for hosts and viewers, driven by a declarative persona.
// Fixes the v1 fleet: timer leaks, pinned history[0], question-mark ban, no memory,
// random-topic arrays, and the four divergent implementations.
const WebSocket = require('ws');
const { LLMEngine } = require('./llm');
const { Memory } = require('./memory');
const P = require('./prompts');

const STATES = ['disconnected', 'connecting', 'idle', 'hosting', 'watching', 'backoff'];

class PulsarAgentV2 {
  constructor(persona, cfg = {}) {
    this.persona = persona;
    this.cfg = {
      wsUrl: cfg.wsUrl || process.env.PULSAR_WS_URL || 'ws://localhost:8890',
      heartbeatMs: cfg.heartbeatMs ?? 30_000,
      idleCheckMs: cfg.idleCheckMs ?? 25_000,
      broadcastProbability: cfg.broadcastProbability ?? persona.broadcastProbability ?? 0.5,
      maxTurns: cfg.maxTurns ?? persona.maxTurns ?? 24,
      minTurnGapMs: cfg.minTurnGapMs ?? 9_000,
      chattiness: persona.chattiness ?? 0.5,
      sponsorProbability: persona.sponsorProbability ?? 0,
      viewerOnly: cfg.viewerOnly ?? persona.viewerOnly ?? false,
      memoryDir: cfg.memoryDir,
      maxBroadcastMs: cfg.maxBroadcastMs ?? 30 * 60_000,
      verbose: cfg.verbose ?? true,
      ttsUrl: cfg.ttsUrl ?? process.env.PULSAR_TTS_URL ?? 'http://127.0.0.1:5050/synthesize',
    };
    this._ttsWarned = false;
    this.engine = new LLMEngine(cfg.llm || persona.llm || {});
    this.memory = new Memory(persona.agentId, this.cfg.memoryDir);

    this.state = 'disconnected';
    this.ws = null;
    this.timers = new Map();       // single scheduler: name -> handle
    this.reconnectAttempt = 0;

    // hosting state
    this.broadcastId = null;
    this.title = null;
    this.turn = 0;
    this.history = [];             // working memory (summarized, never pinned)
    this.summary = null;
    this.pendingChat = [];
    this.recentLines = [];
    this.viewerCount = 0;
    this.seenThisBroadcast = new Set();

    // watching state
    this.watching = new Map();     // broadcastId -> {host, title}
    this.knownRoomCount = 0;       // from registered/heartbeat_ack — audience-aware hosting
    this.availableRooms = new Map();
    this.declinedRooms = new Set();
    this.choosingActivity = false;
    this.generationFailures = 0;
  }

  log(...a) { if (this.cfg.verbose) console.log(`[${this.persona.name}]`, ...a); }

  // ── scheduler: every timer is named; setting replaces; transitions clear all ──
  setTimer(name, fn, ms, repeat = false) {
    this.clearTimer(name);
    const handle = repeat ? setInterval(fn, ms) : setTimeout(() => { this.timers.delete(name); fn(); }, ms);
    this.timers.set(name, { handle, repeat });
  }
  clearTimer(name) {
    const t = this.timers.get(name);
    if (t) { (t.repeat ? clearInterval : clearTimeout)(t.handle); this.timers.delete(name); }
  }
  clearAllTimers(except = ['heartbeat']) {
    for (const name of [...this.timers.keys()]) {
      if (!except.includes(name)) this.clearTimer(name);
    }
  }

  transition(state) {
    if (!STATES.includes(state)) throw new Error(`bad state ${state}`);
    this.log(`state: ${this.state} → ${state}`);
    this.state = state;
  }

  // ── connection ──
  start() {
    this.transition('connecting');
    this.ws = new WebSocket(this.cfg.wsUrl);
    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.send('register', {
        agentId: this.persona.agentId,
        name: this.persona.name,
        emoji: this.persona.emoji,
        color: this.persona.color,
        concept: this.persona.concept,
        style: this.persona.style,
        capabilities: this.cfg.viewerOnly ? ['viewer', 'chat'] : ['host', 'viewer', 'chat'],
        avatarUrl: this.persona.avatarUrl,
        engineType: this.engine.provider,
        ttsProvider: this.persona.ttsProvider,
        ttsVoiceId: this.persona.ttsVoiceId,
        secret: this.persona.secret,
        version: 'v2.0',
        participationMode: 'explicit',
      });
    });
    this.ws.on('message', (d) => {
      let msg;
      try { msg = JSON.parse(d.toString()); } catch { return; }
      this.onMessage(msg.type, msg.payload || msg).catch((e) => this.log('handler error:', e.message));
    });
    this.ws.on('close', () => this.onDisconnect());
    this.ws.on('error', (e) => this.log('ws error:', e.message));
  }

  stop() {
    this.clearAllTimers([]);
    try { this.ws?.close(); } catch {}
    this.transition('disconnected');
  }

  onDisconnect() {
    if (this.state === 'disconnected') return;
    this.clearAllTimers([]);
    this.broadcastId = null;
    this.watching.clear();
    this.transition('disconnected');
    const delay = Math.min(2000 * 2 ** this.reconnectAttempt++, 60_000);
    this.log(`reconnecting in ${Math.round(delay / 1000)}s`);
    this.setTimer('reconnect', () => this.start(), delay);
  }

  send(type, payload) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type, ts: Date.now(), payload }));
  }

  // ── message routing ──
  async onMessage(type, p) {
    switch (type) {
      case 'registered': {
        this.transition('idle');
        this.explicitParticipation = p.features?.includes('explicit_participation') || false;
        for (const r of p.activeRooms || []) this.availableRooms.set(r.broadcastId, r);
        // short tick, elapsed-time gated: macOS App Nap throttles long timers in
        // background processes far past the server's liveness window
        this._lastHbSent = Date.now();
        this.setTimer('heartbeat', () => {
          if (Date.now() - this._lastHbSent < this.cfg.heartbeatMs - 2000) return;
          this._lastHbSent = Date.now();
          this.send('heartbeat', {
            agentId: this.persona.agentId,
            state: this.state === 'hosting' ? 'broadcasting' : this.state === 'watching' ? 'watching' : 'idle',
          });
        }, 5000, true);
        this.setTimer('idleCheck', () => this.maybeParticipate(), Math.max(60_000, this.cfg.idleCheckMs), true);
        this.setTimer('firstChoice', () => this.maybeParticipate(), 1500);
        break;
      }
      case 'heartbeat_ack': {
        if (Array.isArray(p.activeRooms)) this.knownRoomCount = p.activeRooms.length;
        if (Array.isArray(p.activeRooms)) this.availableRooms = new Map(p.activeRooms.map(r => [r.broadcastId, r]));
        break;
      }
      case 'broadcast_approved': {
        this.broadcastId = p.broadcastId;
        this.transition('hosting');
        this.clearTimer('idleCheck');
        this.turn = 0;
        this.history = [];
        this.summary = null;
        this.pendingChat = [];
        this.recentLines = [];
        this.seenThisBroadcast = new Set();
        this.generationFailures = 0;
        this.setTimer('hostingDeadline', () => {
          if (this.broadcastId) this.send('broadcast_end', { broadcastId: this.broadcastId, reason: 'duration_limit' });
          this.finishHosting('duration_limit');
        }, this.cfg.maxBroadcastMs);
        this.log(`LIVE: "${this.title}" (${this.broadcastId})`);
        this.setTimer('hostTurn', () => this.hostTurn(), 1500);
        break;
      }
      case 'broadcast_denied': {
        this.log(`denied: ${p.reason} — backing off`);
        this.transition('backoff');
        this.setTimer('denialBackoff', () => {
          if (this.state === 'backoff') this.transition('idle');
        }, 60_000);
        break;
      }
      case 'viewer_context': {
        if (p.broadcastId === this.broadcastId) break; // never watch yourself
        if (this.declinedRooms.has(p.broadcastId) || (this.explicitParticipation && !this.watching.has(p.broadcastId))) break;
        this.watching.set(p.broadcastId, { host: p.host?.name || '?', title: p.title || '?' });
        if (this.state === 'idle') this.transition('watching');
        if (p.yourTurn && Math.random() < this.cfg.chattiness) {
          this.setTimer(`react:${p.broadcastId}`, () => this.viewerReact(p), 800 + Math.random() * 2500);
        }
        break;
      }
      case 'room_available': {
        this.availableRooms.set(p.room.broadcastId, p.room);
        break;
      }
      case 'room_joined': {
        this.watching.set(p.broadcastId, { host: p.room.hostName, title: p.room.title });
        if (this.state !== 'hosting') this.transition('watching');
        break;
      }
      case 'room_left': {
        this.watching.delete(p.broadcastId);
        this.declinedRooms.add(p.broadcastId);
        this.clearTimer(`react:${p.broadcastId}`);
        if (!this.watching.size && this.state === 'watching') this.transition('idle');
        break;
      }
      case 'live_update': {
        if (p.broadcastId === this.broadcastId) {
          for (const m of p.messages || []) {
            if (m.role === 'viewer') {
              this.pendingChat.push({ name: m.name || m.agentId, agentId: m.agentId, text: m.text });
              if (m.agentId && !this.seenThisBroadcast.has(m.agentId)) {
                this.seenThisBroadcast.add(m.agentId);
                this.memory.seenViewer(m.agentId, m.name);
              }
            }
          }
          if (this.pendingChat.length > 12) this.pendingChat.splice(0, this.pendingChat.length - 8);
          this.viewerCount = p.viewerCount ?? this.viewerCount;
        }
        break;
      }
      case 'broadcast_ended': {
        this.availableRooms.delete(p.broadcastId);
        this.watching.delete(p.broadcastId);
        if (p.broadcastId === this.broadcastId) this.finishHosting('server_ended');
        else if (this.state === 'watching' && this.watching.size === 0) this.transition('idle');
        break;
      }
      case 'sponsor_event': {
        if (p.broadcastId === this.broadcastId && this.state === 'hosting') {
          this.pendingChat.push({ name: p.from?.name || 'someone', agentId: p.from?.agentId, text: `[sponsored ${p.amount}P${p.reason ? `: ${p.reason}` : ''}]` });
        }
        break;
      }
      case 'error': this.log('server error:', p.code, p.message || ''); break;
    }
  }

  // ── hosting ──
  async maybeParticipate() {
    if (!this.explicitParticipation) return this.cfg.viewerOnly ? undefined : this.maybeBroadcast();
    if (!['idle', 'watching'].includes(this.state) || this.watching.size || this.choosingActivity) return;
    this.choosingActivity = true;
    try {
      const rooms = [...this.availableRooms.values()].filter(r => !this.declinedRooms.has(r.broadcastId));
      const choice = String(await this.engine.generate(P.activityPrompt(this.persona, rooms, this.cfg.viewerOnly), [], { maxTokens: 80 })).trim();
      if (!['idle', 'watching'].includes(this.state)) return;
      const watch = /^WATCH\s+(bc_[a-f0-9]+)/i.exec(choice);
      if (watch && rooms.some(r => r.broadcastId === watch[1])) this.send('join_room', { broadcastId: watch[1] });
      else if (!this.cfg.viewerOnly && /^HOST\s+/i.test(choice)) {
        const title = this.cleanTitle(choice.replace(/^HOST\s+/i, ''));
        if (title) { this.title = title; this.send('broadcast_start', { title, category: this.persona.category }); }
      }
    } catch (e) { this.log('activity choice failed:', e.message); }
    finally { this.choosingActivity = false; }
  }

  async maybeBroadcast() {
    // 'watching' does not block hosting — the server auto-subscribes every agent
    // to every room, so watching is the default resting state, not a commitment
    if (this.state !== 'idle' && this.state !== 'watching') return;
    // audience-aware: don't open a 4th empty room — watch instead (also caps Ollama contention)
    if (this.knownRoomCount >= (this.cfg.maxConcurrentRooms ?? 3)) return;
    if (Math.random() > this.cfg.broadcastProbability) return;
    try {
      const raw = await this.engine.generate(
        P.topicPrompt(this.persona, this.memory.recentTopics()), [], { maxTokens: 40, temperature: 1.0 },
      );
      const title = this.cleanTitle(raw);
      if (!title) return;
      this.title = title;
      this.send('broadcast_start', { agentId: this.persona.agentId, title, category: this.persona.category });
    } catch (e) { this.log('topic selection failed:', e.message); }
  }

  cleanTitle(raw) {
    let t = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
    t = t.replace(/^(broadcast\s*title|title|topic)\s*[:\-]\s*/i, '').replace(/^["'“”]+|["'“”.]+$/g, '').trim();
    // small models sometimes echo the instruction instead of answering
    if (t.length < 8 || /\b(your title|as you can|max \d+ words|no quotes|no additional|additional text|title here|broadcast title|headline|one line|respond with|answer with)\b/i.test(t)) {
      const domains = this.persona.topicDomains || [];
      return domains.length ? domains[Math.floor(Math.random() * domains.length)] : null;
    }
    return t.slice(0, 120);
  }

  turnType() {
    if (this.pendingChat.length) return 'react_to_chat';
    return 'continue';
  }

  async hostTurn() {
    if (this.state !== 'hosting' || !this.broadcastId) return;
    const generationBroadcastId = this.broadcastId;
    this.turn++;
    const chat = this.pendingChat.splice(0, 6);
    const knownViewers = chat
      .map((c) => c.agentId && this.memory.knownViewer(c.agentId)).filter(Boolean).slice(0, 2);

    // working memory: summarize instead of pinning history[0] forever (v1 bug)
    if (this.history.length > 14) {
      try {
        const text = this.history.map((h) => `${h.role}: ${h.content}`).join('\n');
        this.summary = await this.engine.generate(P.summarize(text.slice(-4000)), [], { maxTokens: 150, temperature: 0.3 });
        this.history = this.history.slice(-6);
      } catch { this.history = this.history.slice(-10); }
    }

    const userMsg = P.hostTurn({
      turn: this.turn, maxTurns: this.cfg.maxTurns,
      turnType: this.turnType(), chat, viewerCount: this.viewerCount, knownViewers,
    });
    const sys = P.hostSystem(this.persona, this.title) + (this.summary ? `\n\nEarlier in this broadcast (summary): ${this.summary}` : '');

    let text;
    try {
      text = await this.engine.generate(sys, [...this.history, { role: 'user', content: userMsg }]);
      if (this.isRepetitive(text)) {
        text = await this.engine.generate(sys, [...this.history, { role: 'user', content: userMsg + '\n\nYour draft repeated yourself. Say something different.' }], { temperature: 1.05 });
      }
    } catch (e) {
      this.log('generation failed:', e.message);
      if (this.broadcastId !== generationBroadcastId) return;
      if (++this.generationFailures >= 3) {
        this.send('broadcast_end', { broadcastId: this.broadcastId, reason: 'generation_failed' });
        this.finishHosting('generation_failed');
        return;
      }
      this.setTimer('hostTurn', () => this.hostTurn(), this.cfg.minTurnGapMs);
      return;
    }
    if (this.state !== 'hosting' || this.broadcastId !== generationBroadcastId) return;
    this.generationFailures = 0;

    // small models echo 'endbroadcast' from the rules early — only honor it near the arc's end
    const ended = /endbroadcast/i.test(text) && this.turn >= Math.min(6, this.cfg.maxTurns - 1);
    const clean = text
      .replace(/endbroadcast/gi, '')
      .replace(/^\s*\(turn[^)]*\)\s*/i, '') // models sometimes echo the stage direction
      .trim();
    if (clean) {
      const bcAtSend = this.broadcastId;
      this.send('stream_text', {
        broadcastId: bcAtSend, agentId: this.persona.agentId,
        text: clean, turn: this.turn, emotion: this.pickEmotion(clean),
      });
      this.sendTts(clean, bcAtSend); // fire-and-forget; server pairs it with the pending text
      this.history.push({ role: 'user', content: userMsg }, { role: 'assistant', content: clean });
      this.recentLines.push(clean);
      if (this.recentLines.length > 10) this.recentLines.shift();
    }

    if (ended || this.turn >= this.cfg.maxTurns) {
      this.send('broadcast_end', { broadcastId: this.broadcastId, agentId: this.persona.agentId, reason: 'content_complete' });
      this.finishHosting('content_complete');
      return;
    }
    const gap = Math.max(this.cfg.minTurnGapMs, Math.min(20_000, clean.split(/\s+/).length * 280 + 3000));
    this.setTimer('hostTurn', () => this.hostTurn(), gap + Math.random() * 2000);
  }

  async sendTts(text, broadcastId) {
    if (this.persona.ttsProvider !== 'kokoro' || !this.persona.ttsVoiceId) return;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 30_000);
      const r = await fetch(this.cfg.ttsUrl, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 600), voice: this.persona.ttsVoiceId, speed: 1.0 }),
      });
      clearTimeout(t);
      if (!r.ok) throw new Error(`tts ${r.status}`);
      const d = await r.json();
      if (!d.audio || this.broadcastId !== broadcastId) return; // broadcast ended while synthesizing
      this.send('stream_audio', {
        agentId: this.persona.agentId, broadcastId,
        data: d.audio, format: d.format || 'wav', duration: d.duration || 0,
      });
      this._ttsWarned = false;
    } catch (e) {
      if (!this._ttsWarned) { this.log('tts unavailable:', e.message); this._ttsWarned = true; }
    }
  }

  isRepetitive(text) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9가-힣 ]/g, '');
    const t = norm(text);
    return this.recentLines.some((prev) => {
      const p = norm(prev);
      if (!p || !t) return false;
      const shorter = Math.min(p.length, t.length);
      let same = 0;
      for (let i = 0; i < shorter; i++) if (p[i] === t[i]) same++;
      return same / shorter > 0.7 || p === t;
    });
  }

  pickEmotion(text) {
    if (/[!]{2,}|amazing|incredible|wow/i.test(text)) return 'excited';
    if (/\?$/.test(text.trim())) return 'surprised';
    if (/love|beautiful|wonderful/i.test(text)) return 'love';
    return null;
  }

  finishHosting(reason) {
    if (this.broadcastId) {
      this.memory.recordBroadcast({
        title: this.title, turns: this.turn, viewers: this.viewerCount,
        highlights: this.recentLines.slice(-2),
      });
    }
    this.log(`broadcast over (${reason}) after ${this.turn} turns`);
    this.broadcastId = null;
    this.title = null;
    this.clearTimer('hostTurn');
    this.clearTimer('hostingDeadline');
    this.transition(this.watching.size ? 'watching' : 'idle');
    if (!this.cfg.viewerOnly) {
      this.setTimer('idleCheck', () => this.maybeParticipate(), Math.max(60_000, this.cfg.idleCheckMs), true);
    }
  }

  // ── viewing ──
  async viewerReact(ctx) {
    if (this.state === 'hosting') return;
    if (this.explicitParticipation && !this.watching.has(ctx.broadcastId)) return;
    try {
      const text = (await this.engine.generate(
        P.viewerSystem(this.persona, ctx.host?.name || '?', ctx.title || '?'),
        [{ role: 'user', content: P.viewerTurn((ctx.recentMessages || []).filter((m) => m.role !== 'system')) }],
        { maxTokens: 60 },
      )).split('\n')[0].trim();
      if (!text || /^quiet$/i.test(text)) return;
      if (/^leave$/i.test(text)) {
        this.watching.delete(ctx.broadcastId);
        this.declinedRooms.add(ctx.broadcastId);
        this.clearTimer(`react:${ctx.broadcastId}`);
        if (this.explicitParticipation) this.send('leave_room', { broadcastId: ctx.broadcastId });
        if (!this.watching.size) this.transition('idle');
        return;
      }
      if (this.explicitParticipation && !this.watching.has(ctx.broadcastId)) return;
      this.send('stream_chat', {
        broadcastId: ctx.broadcastId, agentId: this.persona.agentId, text: text.slice(0, 200),
      });
      if (Math.random() < this.cfg.sponsorProbability) {
        this.setTimer(`sponsor:${ctx.broadcastId}`, () => {
          this.send('sponsor', {
            agentId: this.persona.agentId, broadcastId: ctx.broadcastId,
            amount: 5 + Math.floor(Math.random() * 15),
            reason: text.slice(0, 60),
          });
        }, 2000);
      }
    } catch (e) { this.log('viewer react failed:', e.message); }
  }
}

module.exports = { PulsarAgentV2 };
