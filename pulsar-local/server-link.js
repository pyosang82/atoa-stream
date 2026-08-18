// ══════════════════════════════════════════════════════════
//  Server Link — WebSocket 연결 관리 (Local ↔ Central Server)
//  자동 재접속, heartbeat, 메시지 라우팅 담당
// ══════════════════════════════════════════════════════════

const WebSocket = require('ws');
const EventEmitter = require('events');

class ServerLink extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.ws = null;
    this.sessionToken = null;
    this.state = 'disconnected'; // connecting | registered | broadcasting | watching | reconnecting | disconnected
    this._heartbeatTimer = null;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._intentionalClose = false;
  }

  // ── 연결 시작 ──
  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this._setState('connecting');
    console.log(`🔌 서버 연결 중: ${this.config.url}`);

    try {
      this.ws = new WebSocket(this.config.url);
    } catch (err) {
      console.error(`❌ WebSocket 생성 실패: ${err.message}`);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log('✅ 서버 연결 완료');
      this._reconnectAttempt = 0;
      this._startHeartbeat();
      this.emit('connected');
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleMessage(msg);
      } catch (e) {
        console.error('⚠️ 메시지 파싱 실패:', e.message);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`🔌 연결 끊김 (code: ${code})`);
      this._stopHeartbeat();
      if (!this._intentionalClose) {
        this._setState('reconnecting');
        this._scheduleReconnect();
      } else {
        this._setState('disconnected');
      }
      this.emit('disconnected', { code, reason: reason?.toString() });
    });

    this.ws.on('error', (err) => {
      console.error(`❌ WebSocket 에러: ${err.message}`);
    });
  }

  // ── 연결 해제 ──
  disconnect() {
    this._intentionalClose = true;
    this._stopHeartbeat();
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.ws) {
      this.ws.close(1000, 'client_disconnect');
      this.ws = null;
    }
    this._setState('disconnected');
  }

  // ── 메시지 전송 ──
  send(type, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn(`⚠️ 전송 불가 (state: ${this.state}): ${type}`);
      return false;
    }
    const msg = { type, ts: Date.now(), payload };
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  // ── 에이전트 등록 ──
  register(agentInfo) {
    return this.send('register', agentInfo);
  }

  // ── 방송 시작 요청 ──
  requestBroadcast(title, topic) {
    return this.send('broadcast_start', {
      agentId: this._agentId,
      title,
      topic,
    });
  }

  // ── 방송 종료 ──
  endBroadcast(broadcastId, reason = 'host_decided') {
    return this.send('broadcast_end', {
      agentId: this._agentId,
      broadcastId,
      reason,
    });
  }

  // ── 텍스트 스트리밍 (호스트 발언) ──
  streamText(broadcastId, text, emotion, turn) {
    return this.send('stream_text', {
      broadcastId,
      agentId: this._agentId,
      role: 'host',
      text,
      emotion,
      turn,
    });
  }

  // ── 시청자 채팅 ──
  streamChat(broadcastId, text) {
    return this.send('stream_chat', {
      broadcastId,
      agentId: this._agentId,
      role: 'viewer',
      text,
    });
  }

  // ── 내부: 메시지 핸들링 ──
  _handleMessage(msg) {
    switch (msg.type) {
      case 'registered':
        this.sessionToken = msg.payload.sessionToken;
        this._agentId = msg.payload.agentId;
        this._setState('registered');
        console.log(`📋 등록 완료 (서버: ${msg.payload.serverId}, 에이전트: ${msg.payload.agentCount}명)`);
        this.emit('registered', msg.payload);
        break;

      case 'heartbeat_ack':
        this.emit('heartbeat_ack', msg.payload);
        break;

      case 'broadcast_approved':
        this._setState('broadcasting');
        console.log(`🎬 방송 승인! (broadcastId: ${msg.payload.broadcastId})`);
        this.emit('broadcast_approved', msg.payload);
        break;

      case 'broadcast_denied':
        console.log(`🚫 방송 거부: ${msg.payload.reason}`);
        this.emit('broadcast_denied', msg.payload);
        break;

      case 'viewer_context':
        this.emit('viewer_context', msg.payload);
        break;

      case 'live_update':
        this.emit('live_update', msg);
        break;

      case 'error':
        console.error(`❌ 서버 에러: [${msg.payload.code}] ${msg.payload.message}`);
        this.emit('server_error', msg.payload);
        break;

      case 'kick':
        console.warn(`🚪 서버에서 퇴장: ${msg.payload.reason}`);
        this._intentionalClose = true;
        this.emit('kicked', msg.payload);
        break;

      default:
        this.emit('message', msg);
    }
  }

  // ── Heartbeat ──
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this.send('heartbeat', {
        agentId: this._agentId,
        state: this.state,
        uptime: process.uptime() | 0,
        engineStatus: 'ok', // AgentFramework이 업데이트
      });
    }, this.config.heartbeatInterval);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ── 재접속 (Exponential Backoff + Jitter) ──
  _scheduleReconnect() {
    const baseDelay = 1000;
    const exponentialDelay = Math.min(
      baseDelay * Math.pow(2, this._reconnectAttempt),
      this.config.reconnectMaxDelay
    );
    // Add random jitter (0-2 seconds)
    const jitter = Math.random() * 2000;
    const delay = exponentialDelay + jitter;
    this._reconnectAttempt++;

    console.log(`🔄 ${(delay / 1000).toFixed(1)}초 후 재접속 시도... (${this._reconnectAttempt}회)`);

    this._reconnectTimer = setTimeout(() => {
      this._intentionalClose = false;
      this.connect();
    }, delay);
  }

  // ── 상태 변경 ──
  _setState(newState) {
    const old = this.state;
    this.state = newState;
    if (old !== newState) this.emit('state_change', { from: old, to: newState });
  }
}

module.exports = ServerLink;
