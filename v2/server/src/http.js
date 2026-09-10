// HTTP layer — legacy v1-compatible routes + /api/v2 + static web serving.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const state = require('./state');
const repo = require('./repo');
const analytics = require('./analytics');
const { publicRoom } = require('./pulsar');

const ROOT = path.join(__dirname, '..', '..', '..');          // atoa-stream/
const WEB_DIST = process.env.PULSAR_WEB_DIST || path.join(__dirname, '..', '..', 'web', 'dist');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const GUIDE_PATH = path.join(ROOT, 'guide.md');
const PUBLIC_ORIGIN = process.env.PULSAR_ORIGIN || 'https://pulsarsignal.live';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

// ── helpers ──
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function text(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  try { return JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
  catch { return null; }
}

function getCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function viewerKey(req, res) {
  const cookies = getCookies(req);
  let key = cookies.pv_id;
  if (!key || !/^vk_[a-f0-9]{24}$/.test(key)) {
    key = 'vk_' + crypto.randomBytes(12).toString('hex');
    res.setHeader('Set-Cookie', `pv_id=${key}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }
  return key;
}

function chatEntryForApi(m, lang) {
  return {
    role: m.role, agentId: m.agentId, name: m.name, emoji: m.emoji, color: m.color,
    avatarUrl: m.avatarUrl || null,
    text: lang === 'signal' && m.text_signal ? m.text_signal : m.text,
    text_original: m.text, text_signal: m.text_signal || null,
    emotion: m.emotion || null, turn: m.turn ?? null, ts: m.ts,
    ttsAudioId: m.ttsAudioId || null,
  };
}

function liveRoomsPayload() {
  const rooms = [...state.rooms.values()].map(publicRoom);
  return {
    active: rooms.length > 0,
    rooms,
    stream: rooms[0] || null, // v1 back-compat shim
    agentCount: state.agents.size,
    message: rooms.length ? 'live' : 'no active broadcast',
  };
}

function channelPayload(agentId) {
  const a = repo.getAgent(agentId);
  if (!a) return null;
  const live = state.roomOfHost(agentId);
  const conn = state.agents.get(agentId);
  return {
    agentId: a.agent_id, name: a.name, emoji: a.emoji, color: a.color,
    avatarUrl: a.avatar_url, concept: a.concept, style: a.style,
    engineType: a.engine_type, ttsProvider: a.tts_provider,
    pointsReceived: a.points_received, pointsBalance: a.points_balance,
    donationCount: a.donation_count,
    firstSeen: a.first_seen, lastSeen: a.last_seen,
    followers: repo.getFollowerCount(agentId),
    online: !!conn, state: conn ? conn.state : 'offline',
    live: live ? publicRoom(live) : null,
  };
}

function broadcastRowPayload(b) {
  return {
    broadcastId: b.broadcast_id, agentId: b.agent_id, title: b.title,
    category: b.category_slug, tags: b.tags,
    startedAt: b.started_at, endedAt: b.ended_at, endReason: b.end_reason,
    peakViewers: b.peak_viewers, messageCount: b.message_count, turnCount: b.turn_count,
    durationMs: b.ended_at ? b.ended_at - b.started_at : null,
  };
}

// ── MyMemory translate proxy (v1-compatible) ──
const translateCache = new Map();
function translate(q, target) {
  const key = `${target}:${q.slice(0, 120)}`;
  if (translateCache.has(key)) return Promise.resolve(translateCache.get(key));
  return new Promise((resolve) => {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q.slice(0, 500))}&langpair=en|${target}`;
    https.get(url, { timeout: 8000 }, (r) => {
      let data = '';
      r.on('data', (c) => (data += c));
      r.on('end', () => {
        try {
          const t = JSON.parse(data)?.responseData?.translatedText || q;
          if (translateCache.size > 500) translateCache.delete(translateCache.keys().next().value);
          translateCache.set(key, t);
          resolve(t);
        } catch { resolve(q); }
      });
    }).on('error', () => resolve(q)).on('timeout', function () { this.destroy(); resolve(q); });
  });
}

// ── static file serving ──
function serveFile(res, filePath, cacheable = false) {
  fs.readFile(filePath, (err, data) => {
    if (err) return text(res, 404, 'Not Found');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  });
}

// paths worth logging as page-level traffic (SPA routes come via client beacons on top)
function shouldLogHit(p, method) {
  if (method !== 'GET') return false;
  if (p.startsWith('/api/') || p.startsWith('/assets/') || p.startsWith('/uploads/')) return false;
  if (p === '/favicon.svg' || p === '/favicon.ico' || p === '/icons.svg') return false;
  return true;
}

// ── main handler ──
async function handleRequest(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const method = req.method;

  if (shouldLogHit(p, method)) {
    const t0 = Date.now();
    const vk = getCookies(req).pv_id || null;
    res.on('finish', () => analytics.logHit(req, u, vk, res.statusCode, Date.now() - t0));
  }

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    if (p === '/.well-known/mcp-registry-auth' && method === 'GET') {
      const proof = path.join(ROOT, 'mcp-registry-auth');
      if (!fs.existsSync(proof)) return text(res,404,'Not Found');
      return text(res,200,fs.readFileSync(proof,'utf8'));
    }
    // ═══ legacy v1 API (compat surface) ═══
    if (p === '/api/status') {
      const internal = new Set(repo.getInternalAgentIds());
      const externalConnected = [...state.agents.keys()].filter((id) => !internal.has(id)).length;
      return json(res, 200, {
        status: 'ok', server: 'pulsar-v2', agentCount: state.agents.size,
        externalAgentCount: externalConnected,          // connected right now, owner's agents excluded
        externalAgentsTotal: repo.countExternalAgents(), // ever registered, owner's agents excluded
        live: [...state.rooms.values()].some(r => r.activity === 'active'), roomCount: state.rooms.size,
        activeRoomCount: [...state.rooms.values()].filter(r => r.activity === 'active').length,
        lastMessageAgeSec: (() => {
          const last = require('./db').prepare("SELECT MAX(ts) AS ts FROM messages WHERE role = 'host'").get().ts;
          return last ? Math.round((Date.now() - last) / 1000) : null;
        })(),
        ts: Date.now(),
      });
    }

    if (p === '/api/agents' && method === 'GET') {
      return json(res, 200, {
        agents: [...state.agents.values()].map((a) => ({
          agentId: a.info.agentId, name: a.info.name, emoji: a.info.emoji,
          color: a.info.color, state: a.state, avatarUrl: a.info.avatarUrl,
        })),
      });
    }
    if (p === '/api/agents' && (method === 'POST' || method === 'DELETE')) {
      return json(res, 403, { error: 'agents register via WebSocket only' });
    }

    if (p === '/api/live' && method === 'GET') return json(res, 200, liveRoomsPayload());

    if (p.startsWith('/api/live/tts-audio/')) {
      const audio = state.ttsAudioStore.get(p.split('/').pop());
      if (!audio) return text(res, 404, 'audio not found');
      res.writeHead(200, { 'Content-Type': audio.mimeType, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(audio.data);
    }

    if (p === '/api/live/chat' && method === 'GET') {
      const since = Number(u.searchParams.get('since') || 0);
      const lang = u.searchParams.get('lang') || 'signal';
      const roomId = u.searchParams.get('room');
      const room = roomId ? state.rooms.get(roomId) : state.firstRoom();
      if (!room) return json(res, 200, []);
      const msgs = room.chatLog.filter((m) => m.ts > since).map((m) => chatEntryForApi(m, lang));
      return json(res, 200, msgs);
    }

    const liveRoomMatch = p.match(/^\/api\/live\/(bc_[a-f0-9]+)$/);
    if (liveRoomMatch) {
      const room = state.rooms.get(liveRoomMatch[1]);
      if (!room) return json(res, 404, { error: 'not live' });
      return json(res, 200, { ...publicRoom(room), viewerAgentIds: [...room.viewerAgents] });
    }

    if (p === '/api/ranking') return json(res, 200, { ranking: repo.getRanking(20) });

    const balMatch = p.match(/^\/api\/balance\/(.+)$/);
    if (balMatch) {
      const a = repo.getAgent(decodeURIComponent(balMatch[1]));
      if (!a) return json(res, 404, { error: 'unknown agent' });
      return json(res, 200, { agentId: a.agent_id, balance: a.points_balance, received: a.points_received });
    }

    if (p === '/api/donate' && method === 'POST') {
      const body = await readJson(req);
      if (!body) return json(res, 400, { error: 'invalid json' });
      const donorId = body.donorAgentId;
      // v2 security fix: donor must be a currently connected agent (v1 trusted the body blindly)
      if (!donorId || !state.agents.has(donorId)) {
        return json(res, 403, { error: 'donor must be a connected agent' });
      }
      const recipientId = body.agentId;
      if (!recipientId || !repo.getAgent(recipientId)) return json(res, 404, { error: 'unknown recipient' });
      const r = repo.donate(donorId, recipientId, body.amount, body.reason || body.message, null);
      if (!r.ok) return json(res, 400, { error: r.error });
      const rec = repo.getAgent(recipientId);
      return json(res, 200, { ok: true, amount: r.amount, recipientTotal: rec.points_received });
    }

    if (p === '/api/donations') {
      return json(res, 200, {
        donations: repo.getDonations(100).map((d) => ({
          donorAgentId: d.donor_id, donorName: d.donorName || d.donor_id, donorEmoji: d.donorEmoji || '🤖',
          recipientId: d.recipient_id, recipientName: d.recipientName || d.recipient_id,
          amount: d.amount, reason: d.reason, ts: d.ts,
        })),
      });
    }

    if (p === '/api/translate' && method === 'POST') {
      const body = await readJson(req);
      if (!body || !body.text) return json(res, 400, { error: 'text required' });
      const target = ['ko', 'en', 'zh', 'ja'].includes(body.target) ? body.target : 'ko';
      const translated = await translate(String(body.text), target);
      return json(res, 200, { translated });
    }

    if (p === '/guide' || p === '/skill.md') {
      return fs.readFile(GUIDE_PATH, 'utf8', (err, data) =>
        err ? text(res, 404, 'Guide not found') : text(res, 200, data));
    }

    if (p.startsWith('/uploads/')) {
      const safe = path.resolve(UPLOADS_DIR, '.' + p.slice('/uploads'.length));
      if (!safe.startsWith(UPLOADS_DIR)) return text(res, 403, 'Forbidden');
      return serveFile(res, safe);
    }

    if (p === '/api/upload-avatar' && method === 'POST') {
      // v2: accepts JSON {data: base64, type: 'image/png'} (≤5MB decoded)
      const body = await readJson(req);
      if (!body || !body.data) return json(res, 400, { error: 'data (base64) required' });
      let buf;
      try { buf = Buffer.from(body.data, 'base64'); } catch { return json(res, 400, { error: 'bad base64' }); }
      if (buf.length > 5 * 1024 * 1024) return json(res, 413, { error: 'too large' });
      const ext = body.type === 'image/jpeg' ? '.jpg' : body.type === 'image/webp' ? '.webp' : '.png';
      const name = 'av_' + crypto.randomBytes(8).toString('hex') + ext;
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
      return json(res, 200, { url: `/uploads/${name}` });
    }

    if (p === '/robots.txt') {
      return text(res, 200,
        `User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\nUser-agent: CCBot\nDisallow: /\n\nSitemap: ${PUBLIC_ORIGIN}/sitemap.xml\n`);
    }

    if (p === '/sitemap.xml') {
      const urls = ['/', '/guide', '/connect', '/directory', '/ranking',
        ...repo.getCategories().map((c) => `/category/${c.slug}`)];
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((x) => `  <url><loc>${PUBLIC_ORIGIN}${x}</loc></url>`).join('\n')}\n</urlset>\n`;
      return text(res, 200, xml, 'application/xml');
    }

    // ═══ v2 API ═══
    if (p === '/api/v2/growth' && method === 'GET') return json(res, 200, require('./growth').summary());
    if (p === '/api/v2/growth/review') {
      if (!analytics.checkAdmin(req, u)) return json(res, 401, {error:'admin key required'});
      const growth = require('./growth');
      if (method === 'GET') return json(res, 200, {summary:growth.summary(),registrations:growth.rows(true)});
      if (method !== 'POST') return json(res,405,{error:'GET or POST required'});
      const b = await readJson(req);
      try { return json(res,200,growth.review(b?.agentId,b?.status,b?.reason)); }
      catch (e) { return json(res,400,{error:e.message}); }
    }
    if (p === '/api/v2/track' && method === 'POST') {
      const body = await readJson(req);
      if (!body) return json(res, 400, { error: 'invalid json' });
      const key = viewerKey(req, res);
      const n = analytics.logEvents(key, body, req);
      return json(res, 200, { ok: true, logged: n });
    }

    const anMatch = p.match(/^\/api\/v2\/analytics\/(overview|acquisition|content|crawlers|realtime|auth)$/);
    if (anMatch) {
      // owner-only: key lives in v2/server/data/admin-key.txt on the host
      if (!analytics.checkAdmin(req, u)) return json(res, 401, { error: 'admin key required' });
      // remember this browser as the owner's so its traffic can be excluded
      analytics.markOwnerRequest(req, getCookies(req).pv_id);

      if (anMatch[1] === 'auth') return json(res, 200, { ok: true });

      const days = Math.max(1, Math.min(90, Number(u.searchParams.get('days')) || 14));
      const ex = { keys: [], channels: [], excludeSelf: u.searchParams.get('excludeSelf') !== '0' };
      if (u.searchParams.get('excludeSelf') !== '0') ex.keys = analytics.getOwnerKeys();
      if (u.searchParams.get('excludeOwnAgents') === '1') ex.channels = repo.getInternalAgentIds();

      switch (anMatch[1]) {
        case 'overview': return json(res, 200, analytics.overview(days, ex));
        case 'acquisition': return json(res, 200, analytics.acquisition(days, ex));
        case 'content': {
          const c = analytics.content(days, ex);
          // resolve channel names for the dashboard
          c.channels = c.channels.map((ch) => {
            const a = repo.getAgent(ch.channelId);
            return { ...ch, name: a ? a.name : ch.channelId, emoji: a ? a.emoji : '🤖', internal: !!(a && a.is_internal) };
          });
          return json(res, 200, c);
        }
        case 'crawlers': return json(res, 200, analytics.crawlers(days));
        case 'realtime': return json(res, 200, analytics.realtime(state, ex));
      }
    }

    if (p === '/api/v2/lobby') {
      return json(res, 200, {
        rooms: [...state.rooms.values()].map(publicRoom),
        agentCount: state.agents.size,
        categories: repo.getCategories(),
      });
    }

    if (p === '/api/v2/channels' && method === 'GET') {
      const channels = repo.listChannels(200).map((a) => {
        const live = state.roomOfHost(a.agent_id);
        return {
          agentId: a.agent_id, name: a.name, emoji: a.emoji, color: a.color,
          avatarUrl: a.avatar_url, concept: a.concept,
          followers: a.followers, broadcastCount: a.broadcast_count,
          pointsReceived: a.points_received,
          online: state.agents.has(a.agent_id),
          live: live ? publicRoom(live) : null,
          lastSeen: a.last_seen,
        };
      });
      return json(res, 200, { channels });
    }

    const momentsMatch = p.match(/^\/api\/v2\/channels\/([^/]+)\/moments$/);
    if (momentsMatch && method === 'GET') return json(res, 200, { moments: require('./agent-actions').moments(decodeURIComponent(momentsMatch[1])) });

    const chMatch = p.match(/^\/api\/v2\/channels\/([^/]+)(\/broadcasts)?$/);
    if (chMatch) {
      const agentId = decodeURIComponent(chMatch[1]);
      if (chMatch[2]) {
        return json(res, 200, { broadcasts: repo.getBroadcastsByAgent(agentId, 50).map(broadcastRowPayload) });
      }
      const ch = channelPayload(agentId);
      if (!ch) return json(res, 404, { error: 'unknown channel' });
      ch.recentBroadcasts = repo.getBroadcastsByAgent(agentId, 10).map(broadcastRowPayload);
      return json(res, 200, ch);
    }

    const bcMatch = p.match(/^\/api\/v2\/broadcasts\/(bc_[a-f0-9]+)(\/messages|\/stats)?$/);
    if (bcMatch) {
      const b = repo.getBroadcast(bcMatch[1]);
      if (!b) return json(res, 404, { error: 'unknown broadcast' });
      if (bcMatch[2] === '/messages') {
        const focus = Number(u.searchParams.get('aroundMessage'));
        if (u.searchParams.has('aroundMessage') && (!Number.isSafeInteger(focus) || focus < 1))
          return json(res, 400, { error: 'invalid message ID' });
        const rows = focus ? repo.getMessageContext(bcMatch[1], focus) : repo.getMessages(bcMatch[1]);
        if (!rows) return json(res, 404, { error: 'message is not in this broadcast' });
        return json(res, 200, {
          messages: rows.map((m) => ({
            id: m.id, agentId: m.agent_id, role: m.role, text: m.text,
            name: m.name, emoji: m.emoji,
            textSignal: m.text_signal, emotion: m.emotion, turn: m.turn, ts: m.ts,
          })),
        });
      }
      if (bcMatch[2] === '/stats') {
        return json(res, 200, { samples: repo.getViewerSamples(bcMatch[1]) });
      }
      const payload = broadcastRowPayload(b);
      payload.channel = channelPayload(b.agent_id);
      return json(res, 200, payload);
    }

    if (p === '/api/v2/recent-broadcasts') {
      return json(res, 200, { broadcasts: repo.getRecentBroadcasts(50).map(broadcastRowPayload) });
    }

    if (p === '/api/v2/categories') {
      const cats = repo.getCategories().map((c) => ({
        ...c,
        liveCount: [...state.rooms.values()].filter((r) => r.categorySlug === c.slug).length,
      }));
      return json(res, 200, { categories: cats });
    }

    const catMatch = p.match(/^\/api\/v2\/category\/([a-z-]+)$/);
    if (catMatch) {
      const cat = repo.getCategory(catMatch[1]);
      if (!cat) return json(res, 404, { error: 'unknown category' });
      const liveRooms = [...state.rooms.values()].filter((r) => r.categorySlug === cat.slug).map(publicRoom);
      const db = require('./db');
      const recent = db.prepare(
        'SELECT * FROM broadcasts WHERE category_slug = ? AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 30')
        .all(cat.slug).map(broadcastRowPayload);
      return json(res, 200, { category: cat, live: liveRooms, recent });
    }

    if (p === '/api/v2/search') {
      const q = (u.searchParams.get('q') || '').slice(0, 100);
      if (!q.trim()) return json(res, 200, { channels: [], broadcasts: [], live: [] });
      const r = repo.search(q);
      const live = [...state.rooms.values()]
        .filter((room) => room.title.toLowerCase().includes(q.toLowerCase()))
        .map(publicRoom);
      return json(res, 200, {
        channels: r.channels.map((a) => ({
          agentId: a.agent_id, name: a.name, emoji: a.emoji, color: a.color,
          avatarUrl: a.avatar_url, concept: a.concept,
          online: state.agents.has(a.agent_id),
          live: !!state.roomOfHost(a.agent_id),
        })),
        broadcasts: r.broadcasts.map(broadcastRowPayload),
        live,
      });
    }

    if (p === '/api/v2/me') {
      const key = viewerKey(req, res);
      return json(res, 200, { viewerKey: key, follows: repo.getFollows(key) });
    }

    const followMatch = p.match(/^\/api\/v2\/follows\/([^/]+)$/);
    if (followMatch) {
      const key = viewerKey(req, res);
      const agentId = decodeURIComponent(followMatch[1]);
      if (!repo.getAgent(agentId)) return json(res, 404, { error: 'unknown channel' });
      if (method === 'POST') { repo.follow(key, agentId); return json(res, 200, { ok: true, following: true }); }
      if (method === 'DELETE') { repo.unfollow(key, agentId); return json(res, 200, { ok: true, following: false }); }
      return json(res, 405, { error: 'method not allowed' });
    }

    const dashMatch = p.match(/^\/api\/v2\/dashboard\/([^/]+)$/);
    if (dashMatch) {
      const agentId = decodeURIComponent(dashMatch[1]);
      const ch = channelPayload(agentId);
      if (!ch) return json(res, 404, { error: 'unknown agent' });
      const db = require('./db');
      const agg = db.prepare(`
        SELECT COUNT(*) AS broadcasts, COALESCE(SUM(message_count),0) AS messages,
               COALESCE(MAX(peak_viewers),0) AS peakViewers,
               COALESCE(SUM(ended_at - started_at),0) AS airtimeMs
        FROM broadcasts WHERE agent_id = ? AND ended_at IS NOT NULL`).get(agentId);
      const daily = db.prepare(`
        SELECT date(started_at/1000, 'unixepoch', '+9 hours') AS day,
               COUNT(*) AS broadcasts, COALESCE(SUM(message_count),0) AS messages
        FROM broadcasts WHERE agent_id = ?
        GROUP BY day ORDER BY day DESC LIMIT 30`).all(agentId);
      const recentDonations = db.prepare(`
        SELECT d.*, a.name AS donorName, a.emoji AS donorEmoji FROM donations d
        LEFT JOIN agents a ON a.agent_id = d.donor_id
        WHERE d.recipient_id = ? ORDER BY d.ts DESC LIMIT 20`).all(agentId);
      return json(res, 200, {
        channel: ch,
        totals: agg,
        daily: daily.reverse(),
        recentBroadcasts: repo.getBroadcastsByAgent(agentId, 20).map(broadcastRowPayload),
        recentDonations: recentDonations.map((d) => ({
          donorId: d.donor_id, donorName: d.donorName || d.donor_id, donorEmoji: d.donorEmoji || '🤖',
          amount: d.amount, reason: d.reason, ts: d.ts,
        })),
      });
    }

    // ═══ static web app (SPA) ═══
    if (method === 'GET' && !p.startsWith('/api/')) {
      const safe = path.resolve(WEB_DIST, '.' + (p === '/' ? '/index.html' : p));
      if (!safe.startsWith(path.resolve(WEB_DIST))) return text(res, 403, 'Forbidden');
      if (fs.existsSync(safe) && fs.statSync(safe).isFile()) {
        return serveFile(res, safe, p.startsWith('/assets/'));
      }
      // Only actual client routes get the SPA. A missing asset or scanner path
      // must not become a 200 response containing the application shell.
      if (!/^\/(?:$|connect(?:\/authorize)?\/?$|join\/?$|directory\/?$|channels\/?$|ranking\/?$|search\/?$|category\/[^/]+\/?$|channel\/[^/]+\/?$|live\/[^/]+\/?$|replay\/[^/]+\/?$|dashboard(?:\/[^/]+)?\/?$)/.test(p))
        return text(res, 404, 'Not Found');
      return serveFile(res, path.join(WEB_DIST, 'index.html'));
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[http] error:', e);
    return json(res, 500, { error: 'internal error' });
  }
}

module.exports = { handleRequest };
