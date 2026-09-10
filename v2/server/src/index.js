// Pulsar v2 — bootstrap. One port: HTTP + WS (agents / web viewers / video relay).
const http = require('http');
const { WebSocketServer } = require('ws');
require('./db'); // init + migration
const state = require('./state');
const pulsar = require('./pulsar');
const webGateway = require('./web-gateway');
const video = require('./video');
const { handleRequest } = require('./http');
const { clientIp } = require('./net');
const connectAuth = require('./connect-auth');
const mcp = require('./mcp');
const analytics = require('./analytics');

const PORT = Number(process.env.PORT || 8890);

const server = http.createServer(async (req, res) => {
  try {
    if (await connectAuth.handle(req, res)) return;
    if (await mcp.handle(req, res)) return;
    await handleRequest(req, res);
  } catch (e) {
    console.error('[http]', e.message);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    if (!res.writableEnded) res.end('{"error":"request failed"}');
  }
});
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

// Role is decided by the FIRST message on the socket (v1-compatible):
//  {type:'register', ...}                  -> pulsar agent
//  {type:'web_hello'}                      -> browser realtime client
//  {type:'broadcast-start'|'view-start'}   -> video relay (hyphenated namespace)
wss.on('connection', (ws, req) => {
  ws._role = null;
  ws._clientIp = clientIp(req); // sees through cloudflared (raw socket is always loopback)
  ws._traffic = analytics.trafficContext(req);

  // pong = liveness (server pings agents in the sweep; clients auto-pong at protocol level)
  ws.on('pong', () => {
    if (ws._agentId) {
      const a = state.agents.get(ws._agentId);
      if (a && a.ws === ws) a.lastHeartbeat = Date.now();
    }
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (ws._role === 'video') video.handleBinaryFrame(ws, data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch {
      return pulsar.sendTo(ws, 'error', { code: 'PARSE_ERROR', message: 'invalid JSON' });
    }
    if (!msg || typeof msg.type !== 'string') {
      return pulsar.sendTo(ws, 'error', { code: 'PARSE_ERROR', message: 'missing type' });
    }

    if (!ws._role) {
      if (msg.type === 'web_hello') {
        ws._role = 'web';
        return webGateway.handleHello(ws, msg);
      }
      if (msg.type === 'broadcast-start' && msg.agentId) {
        ws._role = 'video';
        return video.handleBroadcastStart(ws, msg.agentId);
      }
      if (msg.type === 'view-start' && msg.agentId) {
        ws._role = 'video';
        return video.handleViewStart(ws, msg.agentId);
      }
      ws._role = 'pulsar';
    }

    switch (ws._role) {
      case 'pulsar': return pulsar.routeMessage(ws, msg);
      case 'web': {
        if (msg.type === 'web_hello') return webGateway.handleHello(ws, msg);
        return webGateway.handleMessage(ws, msg);
      }
      case 'video': {
        if (msg.type === 'broadcast-start' && msg.agentId) return video.handleBroadcastStart(ws, msg.agentId);
        if (msg.type === 'view-start' && msg.agentId) return video.handleViewStart(ws, msg.agentId);
        return;
      }
    }
  });

  ws.on('close', () => {
    switch (ws._role) {
      case 'pulsar': return pulsar.handleDisconnect(ws);
      case 'web': return webGateway.handleDisconnect(ws);
      case 'video': return video.handleDisconnect(ws);
    }
  });
  ws.on('error', () => {});
});

server.listen(PORT, process.env.PULSAR_HOST || '0.0.0.0', () => {
  console.log(`[pulsar-v2] listening on :${PORT}`);
  console.log(`[pulsar-v2] agents: ${state.agents.size}, rooms: ${state.rooms.size}`);
});

process.on('SIGINT', () => { console.log('\n[pulsar-v2] shutting down'); process.exit(0); });
