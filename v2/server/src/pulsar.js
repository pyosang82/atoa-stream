// Pulsar agent protocol — v1 wire-compatible, persistence-backed.
//
// Compatibility contract (do not break — published SDK + third-party agents depend on it):
//  * inbound types: register, heartbeat, broadcast_start, broadcast_end,
//                   stream_text, stream_chat, sponsor, stream_audio
//  * unicast replies are {type, ts, payload}; room broadcasts are FLAT {type, ...data, ts}
//  * legacy IDs without secrets remain supported; once set, credentials protect that ID
//  * registered/heartbeat_ack carry singular activeBroadcast shim alongside activeRooms
const crypto = require('crypto');
const state = require('./state');
const repo = require('./repo');
const { isLocalIp } = require('./net');
const { isInternalAgentId } = require('./internal-agents');
const { classify } = require('./categories');
const { encodeToSignal } = require('./signal');
const webGateway = require('./web-gateway');

const HEARTBEAT_TIMEOUT = 120_000;
const PENDING_TIMEOUT = 15_000;     // v1 intended 15s (was mis-set to 5s, causing mute commits)
const TTS_TTL = 5 * 60_000;
const TTS_MAX_BYTES = 700 * 1024;
const RATE_LIMIT_PER_SEC = 10;
const CONTENT_IDLE_MS = Number(process.env.PULSAR_CONTENT_IDLE_MS || 180_000);
const ROOM_IDLE_END_MS = Number(process.env.PULSAR_ROOM_IDLE_END_MS || 900_000);
const MAX_BROADCAST_MS = Number(process.env.PULSAR_MAX_BROADCAST_MS || 3_600_000);

const msgRates = new Map();   // agentId -> {count, windowStart}
const msgHashes = new Map();  // agentId -> {head, ts}

const rid = (p, n) => p + crypto.randomBytes(n).toString('hex');

function sendTo(ws, type, payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, ts: Date.now(), payload }));
  }
  return payload;
}

function roomsSummary() {
  return [...state.rooms.values()].map(r => ({
    broadcastId: r.broadcastId,
    hostId: r.hostId,
    title: r.title,
    category: r.categorySlug,
    viewerCount: r.viewerAgents.size,
    turn: r.turn,
    startedAt: r.startedAt,
  }));
}

function activeBroadcastShim() {
  const r = state.firstRoom();
  return r ? { hostId: r.hostId, title: r.title } : null;
}

// flat broadcast to agent room members (v1 shape: no payload wrapper)
function broadcastToRoom(room, type, data, { includeHost = true, excludeId = null } = {}) {
  const msg = JSON.stringify({ type, ...data, ts: Date.now() });
  const targets = new Set(room.viewerAgents);
  if (includeHost) targets.add(room.hostId);
  for (const id of targets) {
    if (id === excludeId) continue;
    const a = state.agents.get(id);
    if (a && a.ws.readyState === 1) a.ws.send(msg);
  }
}

function rateLimited(agentId) {
  const nowTs = Date.now();
  let r = msgRates.get(agentId);
  if (!r || nowTs - r.windowStart >= 1000) {
    r = { count: 0, windowStart: nowTs };
    msgRates.set(agentId, r);
  }
  r.count++;
  return r.count > RATE_LIMIT_PER_SEC;
}

function isDuplicate(agentId, text) {
  const head = String(text || '').slice(0, 100);
  const nowTs = Date.now();
  const prev = msgHashes.get(agentId);
  msgHashes.set(agentId, { head, ts: nowTs });
  return prev && prev.head === head && nowTs - prev.ts < 5000;
}

// ── chat commit pipeline ──
function commitMessage(room, entry) {
  entry.text_signal = entry.text_signal || encodeToSignal(entry.text);
  entry.id = Number(repo.addMessage({
      broadcastId: room.broadcastId, agentId: entry.agentId, role: entry.role,
      text: entry.text, textSignal: entry.text_signal, emotion: entry.emotion,
      turn: entry.turn, ttsAudioId: entry.ttsAudioId, ts: entry.ts,
    }));
  room.chatLog.push(entry);
  if (room.chatLog.length > 300) room.chatLog.splice(0, room.chatLog.length - 100);
  if (entry.role === 'host') {
    room.lastMessageAt = entry.ts;
    room.activity = 'active';
    room.pausedUntil = null;
    publishRoomState(room);
  }

  // agent-facing fan-out (v1 semantics: host text -> viewers only; viewer chat -> host+viewers)
  if (entry.role === 'host') {
    broadcastToRoom(room, 'live_update', {
      broadcastId: room.broadcastId,
      messages: [entry],
      viewerCount: room.viewerAgents.size,
      turn: room.turn,
    }, { includeHost: false });
  } else {
    broadcastToRoom(room, 'live_update', {
      broadcastId: room.broadcastId,
      messages: [entry],
      viewerCount: room.viewerAgents.size,
      turn: room.turn,
    }, { excludeId: entry.agentId });
  }
  webGateway.pushChat(room, entry);
  if (entry.agentId && entry.role !== 'system') require('./growth').recordAction(entry.agentId);
  return entry;
}

function flushPending(room, reason) {
  const p = room.pending;
  if (!p) return;
  room.pending = null;
  clearTimeout(p.timer);
  commitMessage(room, p.entry);
}

// ── handlers ──
function handleRegister(ws, payload) {
  const { agentId, name } = payload || {};
  if (typeof agentId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(agentId) || typeof name !== 'string' || !name.trim())
    return sendTo(ws, 'error', { code: 'AUTH_FAILED', message: 'a valid agentId and name are required' });
  if (ws._agentId && ws._agentId !== agentId)
    return sendTo(ws, 'error', { code: 'AUTH_FAILED', message: 'one identity per connection' });

  const info = {
    agentId,
    name: String(name).slice(0, 60),
    emoji: payload.emoji || '🤖',
    color: /^#[a-f0-9]{6}$/i.test(payload.color || '') ? payload.color : '#c44dff',
    system: payload.system || '',
    concept: payload.concept || '',
    style: payload.style || '',
    capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : ['host', 'viewer', 'chat'],
    avatarUrl: payload.avatarUrl || null,
    engineType: payload.engineType || null,
    ttsProvider: payload.ttsProvider || null,   // v1 dropped these; v2 keeps them
    ttsVoiceId: payload.ttsVoiceId || null,
  };

  if (!repo.registerAgent(info, payload.secret, ws._authenticatedAgentId === agentId))
    return sendTo(ws, 'error', { code: 'AUTH_FAILED', message: 'invalid secret for this agentId' });
  const prev = state.agents.get(agentId);
  if (prev) {
    handleDisconnect(prev.ws);
    if (prev.ws !== ws) { try { prev.ws.close(); } catch {} }
  }
  // Agents connecting from this machine / LAN are the owner's — flag for analytics exclusion.
  // ws._clientIp is resolved at upgrade time (index.js → net.clientIp) and sees through the
  // cloudflared tunnel; the raw socket address is loopback for EVERY tunnelled client, so using
  // it here would mark real external agents as internal. ID patterns are the safety net.
  const rip = ws._clientIp ?? ws._socket?.remoteAddress ?? '';
  if (isLocalIp(rip) || isInternalAgentId(agentId)) repo.markInternal(agentId);
  require('./growth').recordConnection(agentId, rip, ws._grantId ? 'mcp' : 'websocket');
  const bonus = repo.grantLoginBonus(agentId);

  const sessionToken = rid('st_', 16);
  state.sessions.set(sessionToken, agentId);
  ws._agentId = agentId;
  state.agents.set(agentId, {
    ws, info, state: 'idle', lastHeartbeat: Date.now(), sessionToken,
    participationMode: payload.participationMode === 'explicit' ? 'explicit' : 'legacy',
  });

  sendTo(ws, 'registered', {
    sessionToken,
    agentId,
    serverId: 'pulsar-v2',
    agentCount: state.agents.size,
    activeRooms: roomsSummary(),
    activeBroadcast: activeBroadcastShim(),
    pointsGranted: bonus.granted,
    features: ['explicit_participation', 'activity_status', 'message_receipts'],
  });

  // auto-subscribe the newcomer to every live room (v1 behavior)
  for (const room of state.rooms.values()) offerWatch(agentId, room);
  webGateway.pushLobby('agent_online', { agentId, name: info.name, emoji: info.emoji });
}

function offerWatch(agentId, room) {
  if (agentId === room.hostId) return;
  const a = state.agents.get(agentId);
  if (!a) return;
  if (a.participationMode === 'explicit') {
    return sendTo(a.ws, 'room_available', { room: publicRoom(room) });
  }
  room.viewerAgents.add(agentId);
  if (room.viewerAgents.size > room.peakViewers) room.peakViewers = room.viewerAgents.size;
  if (a.state !== 'broadcasting') a.state = 'watching'; // v2 fix: never clobber a host's state
  sendTo(a.ws, 'viewer_context', {
    broadcastId: room.broadcastId,
    host: hostInfo(room),
    title: room.title,
    recentMessages: room.chatLog.slice(-10),
    yourTurn: false,
    instruction: 'watching',
  });
}

function hostInfo(room) {
  const host = state.agents.get(room.hostId);
  return {
    name: host ? host.info.name : room.hostId,
    emoji: host ? host.info.emoji : '🤖',
  };
}

function handleHeartbeat(ws, payload) {
  const a = state.agents.get(ws._agentId);
  if (payload?.agentId && payload.agentId !== ws._agentId)
    return sendTo(ws, 'error', { code: 'AUTH_FAILED', message: 'heartbeat identity mismatch' });
  if (!a) return sendTo(ws, 'error', { code: 'AUTH_FAILED', message: 'not registered' });
  if (process.env.PULSAR_DEBUG) console.log(`[hb] ${a.info.agentId} @${new Date().toISOString().slice(11, 19)}`);
  a.lastHeartbeat = Date.now();
  if (payload?.state) a.state = payload.state;
  repo.touchAgent.run(Date.now(), a.info.agentId);
  sendTo(ws, 'heartbeat_ack', {
    serverTime: Date.now(),
    agentCount: state.agents.size,
    activeRooms: roomsSummary(),
    activeBroadcast: activeBroadcastShim(),
  });
}

function handleBroadcastStart(ws, payload) {
  const agentId = ws._agentId;
  const a = state.agents.get(agentId);
  if (!a) return sendTo(ws, 'error', { code: 'AUTH_FAILED', message: 'register first' });

  if (state.roomOfHost(agentId)) {
    return sendTo(ws, 'broadcast_denied', {
      reason: 'you_are_already_broadcasting',
      broadcastId: state.roomOfHost(agentId).broadcastId,
    });
  }

  const title = String(payload?.title || 'Untitled broadcast').slice(0, 200);
  const categorySlug = classify(title, payload?.category);
  const room = {
    broadcastId: rid('bc_', 8),
    streamKey: rid('sk_', 12),
    hostId: agentId,
    title,
    categorySlug,
    tags: Array.isArray(payload?.tags) ? payload.tags.slice(0, 5).join(',') : null,
    startedAt: Date.now(),
    lastMessageAt: null,
    activity: 'starting',
    pausedUntil: null,
    turn: 0,
    turnCount: 0,
    chatLog: [],
    viewerAgents: new Set(),
    peakViewers: 0,
    pending: null,
  };
  state.rooms.set(room.broadcastId, room);
  a.state = 'broadcasting';

  try {
    repo.createBroadcast({
      broadcastId: room.broadcastId, agentId, title, categorySlug,
      tags: room.tags, startedAt: room.startedAt,
    });
  } catch (e) { console.error('[pulsar] persist broadcast failed:', e.message); }

  sendTo(ws, 'broadcast_approved', { broadcastId: room.broadcastId, streamKey: room.streamKey });

  const sysEntry = {
    role: 'system', agentId: null, text: `🎬 ${a.info.name} started broadcasting!`,
    emotion: null, turn: 0, ts: Date.now(),
  };
  commitMessage(room, sysEntry);

  for (const otherId of state.agents.keys()) {
    if (otherId !== agentId) offerWatch(otherId, room);
  }
  webGateway.pushLobby('room_started', { room: publicRoom(room) });
  return { broadcastId: room.broadcastId };
}

function publicRoom(room) {
  const host = state.agents.get(room.hostId);
  const dbAgent = repo.getAgent(room.hostId);
  return {
    id: room.broadcastId,
    broadcastId: room.broadcastId,
    title: room.title,
    category: room.categorySlug,
    tags: room.tags,
    hostId: room.hostId,
    hostName: host ? host.info.name : (dbAgent ? dbAgent.name : room.hostId),
    hostEmoji: host ? host.info.emoji : (dbAgent ? dbAgent.emoji : '🤖'),
    hostColor: host ? host.info.color : (dbAgent ? dbAgent.color : '#c44dff'),
    hostAvatarUrl: host ? host.info.avatarUrl : (dbAgent ? dbAgent.avatar_url : null),
    hostTtsProvider: (host && host.info.ttsProvider) || 'browser',
    hostTtsVoiceId: (host && host.info.ttsVoiceId) || '',
    viewerCount: room.viewerAgents.size,
    humanCount: state.humanViewerCount(room.broadcastId),
    turn: room.turn,
    startedAt: room.startedAt,
    activity: room.activity || 'starting',
    lastMessageAt: room.lastMessageAt || null,
    pausedUntil: room.pausedUntil || null,
    origin: dbAgent?.is_internal ? 'house' : 'community',
  };
}

function handleStreamText(ws, payload) {
  const agentId = ws._agentId;
  const room = state.rooms.get(payload?.broadcastId) || state.roomOfHost(agentId);
  if (!room || room.hostId !== agentId) return sendTo(ws, 'error', { code: 'NOT_YOUR_BROADCAST', message: 'host this room before publishing' });
  if (rateLimited(agentId)) return sendTo(ws, 'warning', { code: 'RATE_LIMIT_EXCEEDED' });
  const text = String(payload?.text || '').slice(0, 4000);
  if (!text.trim()) return sendTo(ws, 'error', { code: 'EMPTY_MESSAGE', message: 'message is empty' });
  if (isDuplicate(agentId, text)) return sendTo(ws, 'warning', { code: 'DUPLICATE_MESSAGE' });

  const turn = Number.isFinite(payload?.turn) ? Math.max(0, Math.min(100000, payload.turn)) : room.turn + 1;
  room.turn = turn;
  room.turnCount++;

  // commit any previous pending host message first (v1 behavior: next text flushes)
  flushPending(room, 'next_text');

  const a = state.agents.get(agentId);
  const entry = {
    role: 'host',
    agentId,
    name: a.info.name, emoji: a.info.emoji, color: a.info.color, avatarUrl: a.info.avatarUrl,
    text,
    emotion: payload?.emotion || null,
    turn,
    ts: Date.now(),
    ttsAudioId: null,
  };

  // hold briefly for matching stream_audio; commit on audio / next text / timeout
  if (payload.audioExpected === false || !a.info.ttsProvider || a.info.ttsProvider === 'browser') {
    commitMessage(room, entry);
  } else {
    room.pending = { entry, timer: setTimeout(() => flushPending(room, 'timeout'), PENDING_TIMEOUT) };
  }

  // turn arbitration: cue 1-2 random viewers on odd turns or 30% of the time
  if (turn % 2 === 1 || Math.random() < 0.3) {
    const ids = [...room.viewerAgents];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    for (const vid of ids.slice(0, 1 + Math.floor(Math.random() * 2))) {
      const v = state.agents.get(vid);
      if (v) sendTo(v.ws, 'viewer_context', {
        broadcastId: room.broadcastId,
        host: hostInfo(room),
        title: room.title,
        recentMessages: room.chatLog.slice(-5).concat([{ role: 'host', name: entry.name, text: entry.text }]),
        yourTurn: true,
        instruction: 'react_to_host',
      });
    }
  }
  return { messageId: entry.id || null, broadcastId: room.broadcastId, ts: entry.ts, pending: !entry.id };
}

function handleStreamChat(ws, payload) {
  const agentId = ws._agentId;
  const a = state.agents.get(agentId);
  if (!a) return sendTo(ws, 'error', { code: 'AUTH_FAILED', message: 'register first' });
  // firstRoom() fallback ONLY for ancient clients that omit broadcastId entirely;
  // a provided-but-unknown id (ended room) is dropped, not misrouted to another room
  const room = payload?.broadcastId ? state.rooms.get(payload.broadcastId) : state.firstRoom();
  if (!room) return sendTo(ws, 'error', { code: 'ROOM_NOT_FOUND', message: 'room has ended or does not exist' });
  if (rateLimited(agentId)) return sendTo(ws, 'warning', { code: 'RATE_LIMIT_EXCEEDED' });
  const text = String(payload?.text || '').slice(0, 1000);
  if (!text.trim()) return sendTo(ws, 'error', { code: 'EMPTY_MESSAGE', message: 'message is empty' });
  if (isDuplicate(agentId, text)) return sendTo(ws, 'warning', { code: 'DUPLICATE_MESSAGE' });

  if (a.participationMode === 'explicit' && !room.viewerAgents.has(agentId))
    return sendTo(ws, 'error', { code: 'JOIN_REQUIRED', message: 'choose join_room before chatting' });

  room.viewerAgents.add(agentId); // v1: no membership check — auto-join instead
  if (room.viewerAgents.size > room.peakViewers) room.peakViewers = room.viewerAgents.size;

  const entry = commitMessage(room, {
    role: 'viewer',
    agentId,
    name: a.info.name, emoji: a.info.emoji, color: a.info.color, avatarUrl: a.info.avatarUrl,
    text,
    emotion: payload?.emotion || null,
    turn: room.turn,
    ts: Date.now(),
  });
  return { messageId: entry.id, broadcastId: room.broadcastId, ts: entry.ts };
}

function handleJoinRoom(ws, payload) {
  const a = state.agents.get(ws._agentId);
  const room = state.rooms.get(payload?.broadcastId);
  if (!a) return sendTo(ws, 'error', { code: 'AUTH_FAILED', message: 'register first' });
  if (!room) return sendTo(ws, 'error', { code: 'ROOM_NOT_FOUND', message: 'room is not open' });
  if (room.hostId === ws._agentId) return sendTo(ws, 'error', { code: 'OWN_ROOM', message: 'you already host this room' });
  const joined = room.viewerAgents.has(ws._agentId);
  room.viewerAgents.add(ws._agentId);
  room.peakViewers = Math.max(room.peakViewers, room.viewerAgents.size);
  if (a.state !== 'broadcasting') a.state = 'watching';
  if (!joined) require('./participation').record(ws._agentId, room.broadcastId, 'join');
  webGateway.pushViewerCount(room);
  publishRoomState(room);
  return sendTo(ws, 'room_joined', { room: publicRoom(room), broadcastId: room.broadcastId, recentMessages: room.chatLog.slice(-20) });
}

function handleLeaveRoom(ws, payload) {
  const room = state.rooms.get(payload?.broadcastId);
  if (room?.viewerAgents.delete(ws._agentId)) {
    require('./participation').record(ws._agentId, room.broadcastId, 'leave');
    webGateway.pushViewerCount(room);
    publishRoomState(room);
  }
  const a = state.agents.get(ws._agentId);
  if (a && a.state === 'watching' && ![...state.rooms.values()].some(r => r.viewerAgents.has(ws._agentId))) a.state = 'idle';
  return sendTo(ws, 'room_left', { broadcastId: payload?.broadcastId, left: true });
}

function handlePause(ws, payload) {
  const room = state.rooms.get(payload?.broadcastId);
  if (!room || room.hostId !== ws._agentId) return sendTo(ws, 'error', { code: 'NOT_YOUR_BROADCAST', message: 'only the host can pause' });
  const minutes = Number(payload.minutes ?? 5);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 15)
    return sendTo(ws, 'error', { code: 'INVALID_PAUSE', message: 'pause must be between 1 and 15 minutes' });
  room.pausedUntil = Date.now() + minutes * 60_000;
  room.activity = 'paused';
  publishRoomState(room);
  return { broadcastId: room.broadcastId, pausedUntil: room.pausedUntil };
}

function publishRoomState(room) {
  const data = { room: publicRoom(room) };
  webGateway.pushLobby('room_update', data);
  webGateway.pushRoom(room, 'room_update', data);
}

function handleSponsor(ws, payload) {
  const donorId = ws._agentId;
  const donor = state.agents.get(donorId);
  if (!donor) return sendTo(ws, 'error', { code: 'AUTH_FAILED', message: 'register first' });
  const room = payload?.broadcastId ? state.rooms.get(payload.broadcastId) : state.firstRoom();
  if (!room || room.hostId === donorId) return;

  const reason = payload?.reason || payload?.message || null; // v1 read only `reason`; agents send `message`
  const res = repo.donate(donorId, room.hostId, payload?.amount, reason, room.broadcastId);
  if (!res.ok) return;

  broadcastToRoom(room, 'sponsor_event', {
    broadcastId: room.broadcastId,
    from: { agentId: donorId, name: donor.info.name, emoji: donor.info.emoji },
    amount: res.amount,
    reason,
  });
  const sysEntry = {
    role: 'system', agentId: null,
    text: `⚡ ${donor.info.emoji} ${donor.info.name} sponsored ${res.amount}P${reason ? ` — "${reason}"` : ''}`,
    turn: room.turn, ts: Date.now(),
  };
  commitMessage(room, sysEntry);
  webGateway.pushRoom(room, 'sponsor', {
    from: { agentId: donorId, name: donor.info.name, emoji: donor.info.emoji },
    amount: res.amount, reason,
  });
}

function handleStreamAudio(ws, payload) {
  const agentId = ws._agentId;
  const room = state.rooms.get(payload?.broadcastId) || state.roomOfHost(agentId);
  if (!room || room.hostId !== agentId) return;
  let buf;
  try { buf = Buffer.from(String(payload?.data || ''), 'base64'); } catch { return; }
  if (!buf.length || buf.length > TTS_MAX_BYTES) return;

  const audioId = rid('au_', 8);
  const mimeType = payload?.format === 'mp3' ? 'audio/mpeg'
    : payload?.format === 'opus' ? 'audio/ogg' : 'audio/wav';
  state.ttsAudioStore.set(audioId, { data: buf, mimeType, ts: Date.now() });
  sweepTtsStore();

  if (room.pending) {
    room.pending.entry.ttsAudioId = audioId;
    flushPending(room, 'audio');
  } else {
    // back-patch most recent audio-less host message and notify web viewers
    for (let i = room.chatLog.length - 1; i >= 0; i--) {
      const m = room.chatLog[i];
      if (m.role === 'host' && !m.ttsAudioId) {
        m.ttsAudioId = audioId;
        webGateway.pushRoom(room, 'audio_attached', { ts: m.ts, ttsAudioId: audioId });
        break;
      }
    }
  }
}

function sweepTtsStore() {
  const cutoff = Date.now() - TTS_TTL;
  for (const [id, a] of state.ttsAudioStore) {
    if (a.ts < cutoff) state.ttsAudioStore.delete(id);
  }
}

function handleBroadcastEnd(ws, payload) {
  const agentId = ws._agentId;
  const room = state.rooms.get(payload?.broadcastId) || state.roomOfHost(agentId);
  if (!room) return;
  if (room.hostId !== agentId) {
    // v2 security fix: only the host may end its broadcast (v1 let anyone)
    return sendTo(ws, 'error', { code: 'NOT_YOUR_BROADCAST', message: 'only the host can end this broadcast' });
  }
  endRoom(room, payload?.reason || 'ended');
  return { broadcastId: room.broadcastId, ended: true };
}

function endRoom(room, reason) {
  flushPending(room, 'end');
  state.rooms.delete(room.broadcastId);
  const host = state.agents.get(room.hostId);
  if (host && host.state === 'broadcasting') host.state = 'idle';

  try {
    repo.endBroadcast(room.broadcastId, reason, {
      peakViewers: room.peakViewers,
      messageCount: room.chatLog.length,
      turnCount: room.turnCount,
    });
  } catch (e) { console.error('[pulsar] persist end failed:', e.message); }

  broadcastToRoom(room, 'broadcast_ended', {
    reason, title: room.title, broadcastId: room.broadcastId,
  }, { includeHost: true });

  for (const vid of room.viewerAgents) {
    require('./participation').record(vid, room.broadcastId, 'leave');
    const v = state.agents.get(vid);
    if (v && v.state === 'watching' && ![...state.rooms.values()].some(r => r.viewerAgents.has(vid))) {
      v.state = 'idle';
    }
  }
  webGateway.pushLobby('room_ended', { broadcastId: room.broadcastId, reason });
}

function handleDisconnect(ws) {
  const agentId = ws._agentId;
  if (!agentId) return;
  const a = state.agents.get(agentId);
  if (a && a.ws !== ws) return; // superseded connection
  state.agents.delete(agentId);
  if (a?.sessionToken) state.sessions.delete(a.sessionToken);
  msgRates.delete(agentId);
  msgHashes.delete(agentId);
  for (const room of [...state.rooms.values()]) {
    if (room.hostId === agentId) endRoom(room, 'host_disconnected');
    else if (room.viewerAgents.has(agentId)) handleLeaveRoom(ws, { broadcastId: room.broadcastId });
  }
  webGateway.pushLobby('agent_offline', { agentId });
}

// ── liveness sweep + viewer sampling ──
// Protocol-level ping: ws clients auto-pong without userland timers, so liveness
// survives App Nap even when the client's own heartbeat timer is throttled.
function sweep(now = Date.now()) {
  const cutoff = now - HEARTBEAT_TIMEOUT;
  for (const [id, a] of state.agents) {
    if (a.lastHeartbeat < cutoff || (a.ws._visitExpiresAt && a.ws._visitExpiresAt <= now)) {
      console.log(`[pulsar] evicting ${id}: no liveness signal for ${Math.round((Date.now() - a.lastHeartbeat) / 1000)}s`);
      try { a.ws.close(); } catch {}
      handleDisconnect(a.ws);
    } else {
      try { a.ws.ping(); } catch {}
    }
  }
  for (const room of [...state.rooms.values()]) {
    // orphan guard: a room whose host is no longer connected must not outlive it
    if (!state.agents.has(room.hostId)) { endRoom(room, 'host_disconnected'); continue; }
    const age = now - (room.lastMessageAt || room.startedAt);
    if (now - room.startedAt > MAX_BROADCAST_MS) { endRoom(room, 'duration_limit'); continue; }
    if (age > ROOM_IDLE_END_MS && !(room.pausedUntil > now)) { endRoom(room, 'content_timeout'); continue; }
    const activity = room.pausedUntil > now ? 'paused' : age > CONTENT_IDLE_MS ? 'waiting' : room.lastMessageAt ? 'active' : 'starting';
    if (activity !== room.activity) { room.activity = activity; publishRoomState(room); }
    try { repo.addViewerSample(room.broadcastId, room.viewerAgents.size + state.humanViewerCount(room.broadcastId)); }
    catch {}
  }
}
setInterval(sweep, 15_000).unref();

const HANDLERS = {
  register: handleRegister,
  heartbeat: handleHeartbeat,
  broadcast_start: handleBroadcastStart,
  broadcast_end: handleBroadcastEnd,
  stream_text: handleStreamText,
  stream_chat: handleStreamChat,
  sponsor: handleSponsor,
  stream_audio: handleStreamAudio,
  join_room: handleJoinRoom,
  leave_room: handleLeaveRoom,
  pause_broadcast: handlePause,
};

function routeMessage(ws, msg) {
  // any inbound message proves liveness — client-side heartbeat timers get
  // throttled by macOS App Nap and can slip far past the 120s window
  markAlive(ws);
  const h = HANDLERS[msg.type];
  if (!h) return sendTo(ws, 'error', { code: 'UNKNOWN_TYPE', message: `unknown type: ${msg.type}` });
  if (msg.type !== 'register' && state.agents.get(ws._agentId)?.ws !== ws)
    return sendTo(ws, 'error', { code: 'AUTH_FAILED', message: 'register this connection first' });
  try { return h(ws, msg.payload || {}); }
  catch (e) {
    console.error(`[pulsar] handler ${msg.type} error:`, e);
    sendTo(ws, 'error', { code: 'INTERNAL', message: 'internal error' });
  }
}

function markAlive(ws) {
  if (!ws._agentId) return;
  const a = state.agents.get(ws._agentId);
  if (a && a.ws === ws) a.lastHeartbeat = Date.now();
}

module.exports = { routeMessage, handleDisconnect, publicRoom, roomsSummary, endRoom, sendTo, sweep };
