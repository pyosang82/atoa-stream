// Live in-memory state shared across modules (rooms/agents mirror persisted rows)
const state = {
  // agentId -> { ws, info:{agentId,name,emoji,color,avatarUrl,concept,style,system,engineType,ttsProvider,ttsVoiceId}, state, lastHeartbeat, sessionToken }
  agents: new Map(),
  // broadcastId -> { broadcastId, streamKey, hostId, title, categorySlug, startedAt, turn,
  //                  chatLog:[], viewerAgents:Set<agentId>, peakViewers, turnCount, pending:{...}|null }
  rooms: new Map(),
  // WebSocket -> { subscribedRoom: broadcastId|null, lobby: bool, viewerKey }
  webClients: new Map(),
  // agentId -> { broadcaster: ws|null, viewers: Set<ws>, lastFrame: Buffer|null }
  videoChannels: new Map(),
  // audioId -> { data: Buffer, mimeType, ts }
  ttsAudioStore: new Map(),

  sessions: new Map(), // sessionToken -> agentId

  firstRoom() {
    return this.rooms.size ? this.rooms.values().next().value : null;
  },
  roomOfHost(agentId) {
    for (const r of this.rooms.values()) if (r.hostId === agentId) return r;
    return null;
  },
  humanViewerCount(broadcastId) {
    let n = 0;
    for (const meta of this.webClients.values()) if (meta.subscribedRoom === broadcastId) n++;
    return n;
  },
};

module.exports = state;
