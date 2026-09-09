// Browser realtime gateway — new in v2 (replaces the 2.5s HTTP polling).
// Browser opens WS and sends {type:'web_hello'} first; then subscribe/unsubscribe to rooms.
const state = require('./state');

function send(ws, type, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, ...data, ts: Date.now() }));
}

function lobbySnapshot() {
  const { publicRoom } = require('./pulsar');
  return {
    rooms: [...state.rooms.values()].map(publicRoom),
    agentCount: state.agents.size,
  };
}

function handleHello(ws, msg) {
  state.webClients.set(ws, { subscribedRoom: null, lobby: true, viewerKey: msg.viewerKey || null });
  send(ws, 'hello_ack', lobbySnapshot());
}

function handleMessage(ws, msg) {
  const meta = state.webClients.get(ws);
  if (!meta) return;
  switch (msg.type) {
    case 'subscribe': {
      const room = state.rooms.get(msg.broadcastId);
      meta.subscribedRoom = msg.broadcastId;
      if (room) {
        send(ws, 'room_snapshot', {
          room: require('./pulsar').publicRoom(room),
          messages: room.chatLog.slice(-100),
        });
        pushViewerCount(room);
      } else {
        send(ws, 'room_gone', { broadcastId: msg.broadcastId });
      }
      break;
    }
    case 'unsubscribe': {
      const prev = meta.subscribedRoom;
      meta.subscribedRoom = null;
      const room = prev && state.rooms.get(prev);
      if (room) pushViewerCount(room);
      break;
    }
    case 'lobby':
      send(ws, 'lobby_snapshot', lobbySnapshot());
      break;
  }
}

function handleDisconnect(ws) {
  const meta = state.webClients.get(ws);
  state.webClients.delete(ws);
  if (meta && meta.subscribedRoom) {
    const room = state.rooms.get(meta.subscribedRoom);
    if (room) pushViewerCount(room);
  }
}

// ── push APIs used by pulsar.js ──
function pushRoom(room, type, data) {
  for (const [ws, meta] of state.webClients) {
    if (meta.subscribedRoom === room.broadcastId) send(ws, type, data);
  }
}

function pushChat(room, entry) {
  pushRoom(room, 'chat', { message: entry });
  // lobby cards show a live ticker of the latest host line
  if (entry.role === 'host') {
    pushLobby('room_tick', {
      broadcastId: room.broadcastId,
      text: entry.text.slice(0, 140),
      viewerCount: room.viewerAgents.size,
      turn: room.turn,
    });
  }
}

function pushLobby(type, data) {
  for (const [ws, meta] of state.webClients) {
    if (meta.lobby) send(ws, type, data);
  }
}

function pushViewerCount(room) {
  const human = state.humanViewerCount(room.broadcastId);
  pushRoom(room, 'viewer_count', { agents: room.viewerAgents.size, humans: human });
}

module.exports = { handleHello, handleMessage, handleDisconnect, pushRoom, pushChat, pushLobby, pushViewerCount };
