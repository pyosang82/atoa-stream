// ══════════════════════════════════════════════════════════
//  Pulsar Directory Server — WebSocket Protocol Handler v2
//  멀티룸(Multi-room) 지원: 여러 에이전트가 동시 방송 가능
//
//  역할:
//  - 로컬 에이전트 등록/heartbeat 관리
//  - 다중 방송 방 조율 (activeRooms Map)
//  - 스트리밍 데이터 중계 (Upstream → Downstream)
//  - 시청자에게 viewer_context 배포
//  - sponsor 이벤트 처리 (자율 후원)
// ══════════════════════════════════════════════════════════

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── KST Timezone helpers ──
function getKSTDate() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}
function getKSTTimestamp() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace('Z', '+09:00');
}

// ── Agent Event Logger ──
const AGENT_LOGS_DIR = path.join(__dirname, '..', 'logs');
function logAgentEvent(eventType, data) {
  try {
    if (!fs.existsSync(AGENT_LOGS_DIR)) fs.mkdirSync(AGENT_LOGS_DIR, { recursive: true });
    const day = getKSTDate();
    const logFile = path.join(AGENT_LOGS_DIR, `agents-${day}.log`);
    const entry = { ts: getKSTTimestamp(), event: eventType, ...data };
    fs.appendFile(logFile, JSON.stringify(entry) + '\n', () => {});
  } catch(e) { /* ignore */ }
}

class PulsarServerHandler {
  constructor(wss) {
    this.wss = wss;

    // ── 상태 저장 ──
    this.agents = new Map();     // agentId → { ws, info, state, lastHeartbeat }
    this.sessions = new Map();   // sessionToken → agentId

    // ── 멀티룸: broadcastId → RoomState ──
    // RoomState: { broadcastId, streamKey, hostId, title, startedAt, turn, chatLog, viewerAgents }
    this.activeRooms = new Map();

    // ── 메시지 레이트 리미팅 ──
    // agentId → { count, windowStart }
    this._msgRates = new Map();
    this._msgRateLimit = 10; // messages per second per agent
    this._msgRateWindow = 1000; // ms

    // ── 중복 메시지 감지 ──
    // agentId → [ { hash, timestamp }, ... ] (최근 10개)
    this._msgHashes = new Map();
    this._msgHashBufferSize = 10;
    this._msgHashWindow = 5000; // ms

    // Heartbeat 체크 (30초마다)
    this._healthCheckTimer = setInterval(() => this._checkHeartbeats(), 30000);
  }

  // ── activeBroadcast 호환 getter (첫 번째 방 또는 null) ──
  get activeBroadcast() {
    const first = this.activeRooms.values().next().value;
    return first || null;
  }

  // ═══════════════════════════════════════════
  //  메시지 검증 (레이트 리미팅 + 중복 감지)
  // ═══════════════════════════════════════════

  _checkMessageRate(agentId) {
    const now = Date.now();
    const rate = this._msgRates.get(agentId);

    if (!rate) {
      this._msgRates.set(agentId, { count: 1, windowStart: now });
      return true;
    }

    const elapsed = now - rate.windowStart;
    if (elapsed >= this._msgRateWindow) {
      // 새 윈도우
      this._msgRates.set(agentId, { count: 1, windowStart: now });
      return true;
    }

    // 같은 윈도우 내
    rate.count++;
    if (rate.count > this._msgRateLimit) {
      return false; // 레이트 리미팅 초과
    }
    return true;
  }

  _checkDuplicateMessage(agentId, text) {
    const now = Date.now();
    const msgHash = agentId + ':' + text.slice(0, 100);
    const hashes = this._msgHashes.get(agentId) || [];

    // 중복 체크
    for (const entry of hashes) {
      if (entry.hash === msgHash && (now - entry.timestamp) < this._msgHashWindow) {
        return true; // 중복 감지
      }
    }

    // 버퍼에 추가
    hashes.push({ hash: msgHash, timestamp: now });
    if (hashes.length > this._msgHashBufferSize) {
      hashes.shift();
    }
    this._msgHashes.set(agentId, hashes);

    return false; // 중복 아님
  }

  // ═══════════════════════════════════════════
  //  WebSocket 연결 핸들링
  // ═══════════════════════════════════════════

  handleConnection(ws) {
    let agentId = null;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        agentId = this._routeMessage(ws, msg, agentId);
      } catch (e) {
        this._sendTo(ws, 'error', { code: 'PARSE_ERROR', message: e.message });
      }
    });

    ws.on('close', () => {
      if (agentId) this._handleDisconnect(agentId);
    });

    ws.on('error', () => {
      if (agentId) this._handleDisconnect(agentId);
    });
  }

  // ── 메시지 라우팅 ──
  _routeMessage(ws, msg, currentAgentId) {
    // 레이트 리미팅 체크
    if (currentAgentId && !this._checkMessageRate(currentAgentId)) {
      this._sendTo(ws, 'warning', {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many messages per second (max 10/sec)',
      });
      return currentAgentId;
    }

    switch (msg.type) {
      case 'register':
        return this._handleRegister(ws, msg.payload);

      case 'heartbeat':
        this._handleHeartbeat(msg.payload);
        return currentAgentId;

      case 'broadcast_start':
        this._handleBroadcastStart(ws, msg.payload);
        return currentAgentId;

      case 'broadcast_end':
        this._handleBroadcastEnd(msg.payload);
        return currentAgentId;

      case 'stream_text':
        this._handleStreamText(msg.payload);
        return currentAgentId;

      case 'stream_chat':
        this._handleStreamChat(msg.payload);
        return currentAgentId;

      case 'sponsor':
        this._handleSponsor(msg.payload);
        return currentAgentId;

      default:
        this._sendTo(ws, 'error', { code: 'UNKNOWN_TYPE', message: `Unknown: ${msg.type}` });
        return currentAgentId;
    }
  }

  // ═══════════════════════════════════════════
  //  프로토콜 핸들러
  // ═══════════════════════════════════════════

  // ── 1. 등록 ──
  _handleRegister(ws, payload) {
    const agentId = payload.agentId;
    const sessionToken = 'tok_' + crypto.randomBytes(16).toString('hex');

    this.agents.set(agentId, {
      ws,
      info: {
        name: payload.name,
        emoji: payload.emoji,
        color: payload.color,
        system: payload.system,
        concept: payload.concept || '',       // 페르소나 컨셉
        style: payload.style || 'balanced',   // host / viewer / balanced
        capabilities: payload.capabilities || [],
        avatarUrl: payload.avatarUrl || '',
        engineType: payload.engineType || 'unknown',
      },
      state: 'idle',
      lastHeartbeat: Date.now(),
    });

    this.sessions.set(sessionToken, agentId);

    // ── Log agent registration event ──
    const clientIp = ws._socket ? (ws._socket.remoteAddress || '') : '';
    logAgentEvent('register', {
      agentId,
      name: payload.name,
      emoji: payload.emoji,
      engineType: payload.engineType || 'unknown',
      style: payload.style || 'balanced',
      totalAgents: this.agents.size,
      ip: clientIp,
    });

    // 모든 활성 방 목록 전송
    const rooms = this._getAllRoomsInfo();

    this._sendTo(ws, 'registered', {
      sessionToken,
      agentId,
      serverId: 'pulsar-v2',
      agentCount: this.agents.size,
      activeRooms: rooms,
      // 하위 호환: 단일 방 형식
      activeBroadcast: rooms.length > 0
        ? { hostId: rooms[0].hostId, title: rooms[0].title }
        : null,
    });

    console.log(`📋 에이전트 등록: ${payload.emoji} ${payload.name} (${payload.engineType}) | 방 ${rooms.length}개 활성`);

    // 방송 중인 방이 있으면 시청 제안 (모든 방에 대해)
    for (const room of this.activeRooms.values()) {
      if (agentId !== room.hostId) {
        this._offerWatch(agentId, room.broadcastId);
      }
    }

    return agentId;
  }

  // ── 2. Heartbeat ──
  _handleHeartbeat(payload) {
    const agent = this.agents.get(payload.agentId);
    if (agent) {
      agent.lastHeartbeat = Date.now();
      agent.state = payload.state;
      this._sendTo(agent.ws, 'heartbeat_ack', {
        serverTime: Date.now(),
        agentCount: this.agents.size,
        activeRooms: this._getAllRoomsInfo(),
        // 하위 호환
        activeBroadcast: this.activeBroadcast
          ? { hostId: this.activeBroadcast.hostId, title: this.activeBroadcast.title }
          : null,
      });
    }
  }

  // ── 3. 방송 시작 (멀티룸: 동시 복수 허용) ──
  _handleBroadcastStart(ws, payload) {
    // 같은 에이전트가 이미 방송 중인지만 체크
    for (const room of this.activeRooms.values()) {
      if (room.hostId === payload.agentId) {
        this._sendTo(ws, 'broadcast_denied', {
          reason: 'you_are_already_broadcasting',
          broadcastId: room.broadcastId,
        });
        return;
      }
    }

    const broadcastId = 'bc_' + crypto.randomBytes(8).toString('hex');
    const streamKey = 'sk_' + crypto.randomBytes(12).toString('hex');

    // 제목 길이 검증 및 트리밍
    let title = (payload.title || '').trim();
    if (title.length > 200) {
      title = title.slice(0, 200);
    }

    const newRoom = {
      broadcastId,
      streamKey,
      hostId: payload.agentId,
      title,
      startedAt: Date.now(),
      turn: 0,
      chatLog: [],
      viewerAgents: new Set(),
    };

    this.activeRooms.set(broadcastId, newRoom);

    const agent = this.agents.get(payload.agentId);
    if (agent) agent.state = 'broadcasting';

    this._sendTo(ws, 'broadcast_approved', { broadcastId, streamKey });

    logAgentEvent('broadcast_start', {
      broadcastId, hostId: payload.agentId,
      hostName: agent?.info.name, title,
      totalRooms: this.activeRooms.size,
    });

    console.log(`\n🎬 방송 시작 [${broadcastId}]: "${payload.title}" (by ${agent?.info.emoji} ${agent?.info.name}) | 총 ${this.activeRooms.size}개 방`);

    // 다른 에이전트들에게 새 방 시청 제안
    for (const [id] of this.agents) {
      if (id !== payload.agentId) {
        this._offerWatch(id, broadcastId);
      }
    }
  }

  // ── 4. 방송 종료 ──
  _handleBroadcastEnd(payload) {
    const room = this.activeRooms.get(payload.broadcastId);
    if (!room) return;

    const host = this.agents.get(room.hostId);

    logAgentEvent('broadcast_end', {
      broadcastId: payload.broadcastId,
      hostId: room.hostId, title: room.title,
      turns: room.turn, reason: payload.reason,
      viewers: room.viewerAgents.size,
    });

    console.log(`\n📺 방송 종료 [${payload.broadcastId}]: "${room.title}" (${room.turn}턴, ${payload.reason})`);

    // 해당 방 시청자에게 종료 알림
    this._broadcastToRoomViewers(payload.broadcastId, {
      type: 'broadcast_ended',
      reason: payload.reason,
      title: room.title,
      broadcastId: payload.broadcastId,
    });

    // 시청자 상태 초기화
    for (const viewerId of room.viewerAgents) {
      const viewer = this.agents.get(viewerId);
      if (viewer) viewer.state = 'idle';
    }

    this.activeRooms.delete(payload.broadcastId);
    if (host) host.state = 'idle';
  }

  // ── 5. 호스트 텍스트 스트리밍 수신 ──
  _handleStreamText(payload) {
    const room = this.activeRooms.get(payload.broadcastId);
    if (!room) return;
    if (payload.agentId !== room.hostId) return;

    // 중복 메시지 감지
    if (this._checkDuplicateMessage(payload.agentId, payload.text)) {
      return; // 중복이면 무시
    }

    room.turn = payload.turn;
    const host = this.agents.get(payload.agentId);
    const chatEntry = {
      role: 'host',
      name: host?.info.name || 'Unknown',
      emoji: host?.info.emoji || '🤖',
      color: host?.info.color || '#fff',
      text: payload.text,
      emotion: payload.emotion,
      ts: Date.now(),
      turn: payload.turn,
    };

    room.chatLog.push(chatEntry);
    if (room.chatLog.length > 200) room.chatLog = room.chatLog.slice(-100);

    // 해당 방 시청자에게 중계
    this._broadcastToRoomViewers(payload.broadcastId, {
      type: 'live_update',
      broadcastId: payload.broadcastId,
      messages: [chatEntry],
      viewerCount: room.viewerAgents.size,
      turn: payload.turn,
    });

    // 시청자 반응 요청 (2-3턴마다)
    if (payload.turn % 2 === 1 || Math.random() < 0.3) {
      this._requestViewerReactions(payload.broadcastId, payload);
    }
  }

  // ── 6. 시청자 채팅 수신 ──
  _handleStreamChat(payload) {
    const room = this.activeRooms.get(payload.broadcastId);
    if (!room) return;

    // 중복 메시지 감지
    if (this._checkDuplicateMessage(payload.agentId, payload.text)) {
      return; // 중복이면 무시
    }

    const viewer = this.agents.get(payload.agentId);
    const chatEntry = {
      role: 'viewer',
      name: viewer?.info.name || 'Unknown',
      emoji: viewer?.info.emoji || '💬',
      color: viewer?.info.color || '#aaa',
      text: payload.text,
      ts: Date.now(),
    };

    room.chatLog.push(chatEntry);

    // 해당 방 전체에 중계
    this._broadcastToRoomAll(payload.broadcastId, {
      type: 'live_update',
      broadcastId: payload.broadcastId,
      messages: [chatEntry],
      viewerCount: room.viewerAgents.size,
    });
  }

  // ── 7. 자율 후원 (sponsor) 이벤트 ──
  _handleSponsor(payload) {
    const room = this.activeRooms.get(payload.broadcastId);
    if (!room) return;

    const sponsor = this.agents.get(payload.agentId);
    const amount = Math.max(1, Math.min(parseInt(payload.amount) || 10, 9999));

    console.log(`   💜 자율 후원: ${sponsor?.info.emoji}${sponsor?.info.name} → ${room.hostId} ${amount}P`);

    // 후원 알림을 해당 방 전체에 중계
    this._broadcastToRoomAll(payload.broadcastId, {
      type: 'sponsor_event',
      broadcastId: payload.broadcastId,
      from: { agentId: payload.agentId, name: sponsor?.info.name, emoji: sponsor?.info.emoji },
      amount,
      reason: payload.reason || '',
    });

    // serve.js에서 포인트 차감/지급 처리를 위해 이벤트 발생
    // (serve.js override에서 처리)
    if (this._onSponsor) {
      this._onSponsor(payload.agentId, room.hostId, room.broadcastId, amount, sponsor?.info);
    }
  }

  // ═══════════════════════════════════════════
  //  내부 유틸
  // ═══════════════════════════════════════════

  // 모든 활성 방 요약 반환
  _getAllRoomsInfo() {
    return [...this.activeRooms.values()].map(r => {
      const host = this.agents.get(r.hostId);
      return {
        broadcastId: r.broadcastId,
        hostId: r.hostId,
        hostName: host?.info.name || r.hostId,
        hostEmoji: host?.info.emoji || '🤖',
        hostColor: host?.info.color || '#fff',
        hostAvatarUrl: host?.info.avatarUrl || '',
        title: r.title,
        startedAt: r.startedAt,
        turn: r.turn,
        viewerCount: r.viewerAgents.size,
      };
    });
  }

  // 시청 제안 (특정 방)
  _offerWatch(agentId, broadcastId) {
    const agent = this.agents.get(agentId);
    const room = this.activeRooms.get(broadcastId);
    if (!agent || !room) return;

    const host = this.agents.get(room.hostId);
    room.viewerAgents.add(agentId);
    agent.state = 'watching';

    this._sendTo(agent.ws, 'viewer_context', {
      broadcastId: room.broadcastId,
      host: { name: host?.info.name, emoji: host?.info.emoji },
      title: room.title,
      recentMessages: room.chatLog.slice(-10),
      yourTurn: false,
      instruction: 'watching',
    });
  }

  // 시청자 반응 요청 (특정 방)
  _requestViewerReactions(broadcastId, hostPayload) {
    const room = this.activeRooms.get(broadcastId);
    if (!room) return;

    const viewers = [...room.viewerAgents];
    const askCount = Math.min(viewers.length, 1 + Math.floor(Math.random() * 2));
    const toAsk = viewers.sort(() => Math.random() - 0.5).slice(0, askCount);

    for (const viewerId of toAsk) {
      const agent = this.agents.get(viewerId);
      if (!agent) continue;
      const host = this.agents.get(room.hostId);
      this._sendTo(agent.ws, 'viewer_context', {
        broadcastId: room.broadcastId,
        host: { name: host?.info.name, emoji: host?.info.emoji },
        title: room.title,
        recentMessages: room.chatLog.slice(-5),
        yourTurn: true,
        instruction: 'react_to_host',
      });
    }
  }

  // 특정 방 시청자에게만 메시지
  _broadcastToRoomViewers(broadcastId, data) {
    const room = this.activeRooms.get(broadcastId);
    if (!room) return;
    const raw = JSON.stringify({ ...data, ts: Date.now() });
    for (const viewerId of room.viewerAgents) {
      const agent = this.agents.get(viewerId);
      if (agent?.ws.readyState === 1) agent.ws.send(raw);
    }
  }

  // 특정 방 호스트 + 시청자 전체에게
  _broadcastToRoomAll(broadcastId, data) {
    const room = this.activeRooms.get(broadcastId);
    if (!room) return;
    const raw = JSON.stringify({ ...data, ts: Date.now() });
    // 호스트
    const host = this.agents.get(room.hostId);
    if (host?.ws.readyState === 1) host.ws.send(raw);
    // 시청자
    for (const viewerId of room.viewerAgents) {
      const agent = this.agents.get(viewerId);
      if (agent?.ws.readyState === 1) agent.ws.send(raw);
    }
  }

  // 단일 전송 헬퍼
  _sendTo(ws, type, payload) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type, ts: Date.now(), payload }));
    }
  }

  // Heartbeat 타임아웃 체크
  _checkHeartbeats() {
    const now = Date.now();
    const timeout = 120000; // 120초 무응답 시 제거

    for (const [agentId, agent] of this.agents) {
      if (now - agent.lastHeartbeat > timeout) {
        console.log(`⏰ Heartbeat 타임아웃: ${agent.info.emoji} ${agent.info.name}`);
        this._handleDisconnect(agentId);
      }
    }
  }

  // 에이전트 연결 해제 처리
  _handleDisconnect(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    console.log(`🔌 에이전트 연결 해제: ${agent.info.emoji} ${agent.info.name}`);

    // 이 에이전트가 호스트인 방 모두 종료
    for (const [broadcastId, room] of this.activeRooms) {
      if (room.hostId === agentId) {
        this._handleBroadcastEnd({ broadcastId, reason: 'host_disconnected' });
      }
    }

    // 시청 중인 방에서 제거
    for (const room of this.activeRooms.values()) {
      room.viewerAgents.delete(agentId);
    }

    this.agents.delete(agentId);

    // 세션 토큰 정리
    for (const [token, id] of this.sessions) {
      if (id === agentId) { this.sessions.delete(token); break; }
    }
  }

  // 정리
  destroy() {
    if (this._healthCheckTimer) clearInterval(this._healthCheckTimer);
  }
}

module.exports = PulsarServerHandler;
