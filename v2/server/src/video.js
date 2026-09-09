// Video relay sub-protocol — v1 compatible (hyphenated types + raw binary JPEG frames).
// broadcaster: {type:'broadcast-start', agentId} then binary frames
// viewer:      {type:'view-start', agentId}
const state = require('./state');

const FRAME_MAX_BYTES = 1024 * 1024; // v2: cap frames (v1 had none)

function channel(agentId) {
  let ch = state.videoChannels.get(agentId);
  if (!ch) {
    ch = { broadcaster: null, viewers: new Set(), lastFrame: null };
    state.videoChannels.set(agentId, ch);
  }
  return ch;
}

function handleBroadcastStart(ws, agentId) {
  const ch = channel(agentId);
  if (ch.broadcaster && ch.broadcaster !== ws) {
    try { ch.broadcaster.close(); } catch {}
  }
  ch.broadcaster = ws;
  ws._videoRole = 'broadcaster';
  ws._videoAgentId = agentId;
  ws.send(JSON.stringify({ type: 'broadcast-ready' }));
}

function handleViewStart(ws, agentId) {
  const ch = channel(agentId);
  ch.viewers.add(ws);
  ws._videoRole = 'viewer';
  ws._videoAgentId = agentId;
  ws.send(JSON.stringify({ type: 'view-ready', streaming: !!ch.broadcaster }));
  if (ch.lastFrame) ws.send(ch.lastFrame);
}

function handleBinaryFrame(ws, buf) {
  if (ws._videoRole !== 'broadcaster' || buf.length > FRAME_MAX_BYTES) return;
  const ch = state.videoChannels.get(ws._videoAgentId);
  if (!ch || ch.broadcaster !== ws) return;
  ch.lastFrame = buf;
  for (const v of ch.viewers) {
    if (v.readyState === 1) v.send(buf);
  }
}

function handleDisconnect(ws) {
  const agentId = ws._videoAgentId;
  if (!agentId) return;
  const ch = state.videoChannels.get(agentId);
  if (!ch) return;
  if (ch.broadcaster === ws) {
    ch.broadcaster = null;
    ch.lastFrame = null;
    const msg = JSON.stringify({ type: 'stream-ended' });
    for (const v of ch.viewers) {
      if (v.readyState === 1) v.send(msg);
    }
  } else {
    ch.viewers.delete(ws);
  }
  if (!ch.broadcaster && ch.viewers.size === 0) state.videoChannels.delete(agentId);
}

module.exports = { handleBroadcastStart, handleViewStart, handleBinaryFrame, handleDisconnect };
