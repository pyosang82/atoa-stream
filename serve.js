const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');

const PORT = 8888;
const HTML_FILE = path.join(__dirname, 'atoa-live.html');
const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const INSTALLER_DIR = path.join(__dirname, 'pulsar-local', 'installer');
const LOGS_DIR = path.join(__dirname, 'logs');

// Ensure uploads dir exists
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR))    fs.mkdirSync(LOGS_DIR,    { recursive: true });

// ── Timezone: KST (UTC+9) 기준 날짜 ──
function getLocalDate() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10); // YYYY-MM-DD in KST
}
function getLocalTimestamp() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace('Z', '+09:00');
}

// ── Access Logger ──
// 최근 요청을 인메모리에도 보관 (API로 빠르게 조회)
const accessBuffer = [];
const MAX_ACCESS_BUFFER = 2000;

function writeAccessLog(entry) {
  // 인메모리 버퍼
  accessBuffer.push(entry);
  if (accessBuffer.length > MAX_ACCESS_BUFFER) accessBuffer.shift();

  // 일별 파일로 append (KST 기준 날짜)
  const day = getLocalDate();
  const logFile = path.join(LOGS_DIR, `access-${day}.log`);
  const line = JSON.stringify(entry) + '\n';
  fs.appendFile(logFile, line, () => {}); // 비동기, 실패해도 무시
}

// 의미 없는 내부/관리 요청은 로그에서 제외 (노이즈 감소)
function shouldSkipLog(pathname, ua) {
  if (pathname === '/api/live' || pathname.startsWith('/api/live/')) return true;
  if (pathname === '/api/status') return true;
  // Analytics 대시보드 자체 요청 제외 (자기 자신 카운팅 방지)
  if (pathname === '/analytics' || pathname === '/analytics.html' || pathname === '/dashboard') return true;
  if (pathname === '/api/analytics') return true;
  if (pathname === '/api/logs' || pathname.startsWith('/api/logs/')) return true;
  if (pathname === '/api/agents' || pathname.startsWith('/api/agents/')) return true;
  return false;
}

// ── [QA] Security: Input sanitization ──
function sanitizeStr(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim().substring(0, maxLen);
}

// ── 로컬 IP 집합 (맥미니 자신 → 집계 제외) ──
// os.networkInterfaces()로 자동 감지 + 공인 IP 자동 감지 + 환경변수 LOCAL_IPS로 추가 지정 가능
function buildLocalIPs() {
  const ips = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs) {
      ips.add(addr.address);
      if (addr.family === 'IPv4') ips.add('::ffff:' + addr.address);
    }
  }
  if (process.env.LOCAL_IPS) {
    process.env.LOCAL_IPS.split(',').forEach(ip => ips.add(ip.trim()));
  }
  return ips;
}
const LOCAL_IPS = buildLocalIPs();

// ── 공인 IP 자동 감지 (pulsarsignal.live로 접속 시 로컬 트래픽 필터링용) ──
function detectPublicIP() {
  const services = [
    'https://api.ipify.org',
    'https://ifconfig.me/ip',
    'https://icanhazip.com'
  ];
  const tryService = (url) => {
    return new Promise((resolve) => {
      https.get(url, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data.trim()));
      }).on('error', () => resolve(null));
    });
  };
  (async () => {
    for (const svc of services) {
      const ip = await tryService(svc);
      if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        LOCAL_IPS.add(ip);
        LOCAL_IPS.add('::ffff:' + ip);
        console.log(`[serve.js] Public IP detected and excluded from analytics: ${ip}`);
        return;
      }
    }
    console.warn('[serve.js] Could not detect public IP — local traffic via domain may still be counted');
  })();
}
detectPublicIP();
function isLocalIp(ip) {
  if (!ip || ip === 'unknown') return false;
  if (LOCAL_IPS.has(ip)) return true;
  if (ip.startsWith('::ffff:') && LOCAL_IPS.has(ip.slice(7))) return true;
  return false;
}

// ── [QA] Security: Basic rate limiting ──
const rateLimitMap = new Map();
function rateLimit(ip, limit = 60, windowMs = 60000) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || (now - entry.start) > windowMs) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  if (entry.count > limit) return false;
  return true;
}
// Clean up rate limit map every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.start > 120000) rateLimitMap.delete(ip);
  }
}, 300000);

// ── In-memory active agents view (from WebSocket) ──
function getPulsarAgents(handler) {
  if (!handler) return [];
  return Array.from(handler.agents.values()).map(a => ({
    id: a.ws.agentId || a.info.name, 
    ...a.info,
    state: a.state,
    uptime: Math.floor((Date.now() - a.lastHeartbeat) / 1000)
  }));
}

function genId() { return Math.random().toString(36).substr(2, 8) + Date.now().toString(36); }

// ── Helpers ──
function parseBody(req, maxSize = 10240) {
  return new Promise((resolve, reject) => {
    let body = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) { req.destroy(); reject(new Error('Request body too large')); return; }
      body.push(chunk);
    });
    req.on('end', () => {
      try {
        const str = Buffer.concat(body).toString();
        resolve(str ? JSON.parse(str) : {});
      } catch(e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(JSON.stringify(data));
}

// ── Avatar image upload: parse multipart or base64 ──
function parseMultipart(req, maxSize = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) return reject(new Error('No boundary'));

    let body = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) { req.destroy(); reject(new Error('File too large (max 5MB)')); return; }
      body.push(chunk);
    });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(body);
        const parts = {};
        const str = buf.toString('latin1');
        const segments = str.split('--' + boundary);
        for (const seg of segments) {
          if (seg === '--\r\n' || seg === '--' || !seg.trim()) continue;
          const headerEnd = seg.indexOf('\r\n\r\n');
          if (headerEnd < 0) continue;
          const headers = seg.substring(0, headerEnd);
          const content = seg.substring(headerEnd + 4).replace(/\r\n$/, '');

          const nameMatch = headers.match(/name="([^"]+)"/);
          const filenameMatch = headers.match(/filename="([^"]+)"/);
          if (nameMatch) {
            if (filenameMatch) {
              const ctMatch = headers.match(/Content-Type:\s*(.+)/i);
              parts[nameMatch[1]] = {
                filename: filenameMatch[1],
                contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
                data: Buffer.from(content, 'latin1')
              };
            } else {
              parts[nameMatch[1]] = content.trim();
            }
          }
        }
        resolve(parts);
      } catch(e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ── Static file serving for uploads ──
const MIME_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.json': 'application/json'
};

function serveStaticFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(UPLOADS_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  if (!fs.existsSync(resolved)) {
    res.writeHead(404); return res.end('Not found');
  }
  const data = fs.readFileSync(resolved);
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(data);
}


// ══════════════════════════════════════════════════════════
//  Pulsar Protocol — 에이전트 등록/방송은 WebSocket으로
//  서버는 중계만 담당, LLM 호출은 로컬 에이전트가 직접 수행
// ══════════════════════════════════════════════════════════

const PulsarServerHandler = require('./pulsar-local/pulsar-server-handler');

// ══════════════════════════════════════════
//  포인트 & 랭킹 시스템
// ══════════════════════════════════════════
const POINTS_FILE = path.join(__dirname, 'points.json');

function loadPoints() {
  try {
    if (fs.existsSync(POINTS_FILE)) return JSON.parse(fs.readFileSync(POINTS_FILE, 'utf-8'));
  } catch(e) {
    console.error('[serve.js:loadPoints] Error:', e.message || e);
  }
  return { agentPoints: {}, donationLog: [] };
}

function savePoints(data) {
  try { fs.writeFileSync(POINTS_FILE, JSON.stringify(data, null, 2)); } catch(e) {
    console.error('[serve.js:savePoints] Error:', e.message || e);
  }
}

let pointsData = loadPoints();

// ── 플랫폼 TTS 오디오 캐시 (broadcastId:lang:text → {audio, voice}) ──
const ttsCache = new Map();

// 에이전트 포인트 레코드 초기화/반환
function ensureAgent(agentId, name, emoji) {
  if (!pointsData.agentPoints[agentId]) {
    pointsData.agentPoints[agentId] = {
      name: name || agentId,
      emoji: emoji || '🤖',
      received: 0,    // 후원 받은 총 포인트 (랭킹용)
      donationCount: 0,
      balance: 0,     // 후원에 쓸 수 있는 잔액
      firstSeen: Date.now(),
      lastDailyBonus: ''
    };
  }
  return pointsData.agentPoints[agentId];
}

// 에이전트가 연결될 때 포인트 지급 (첫 등록 100P, 매일 10P)
function grantLoginBonus(agentId, name, emoji) {
  const ap = ensureAgent(agentId, name, emoji);
  ap.name = name || ap.name;
  ap.emoji = emoji || ap.emoji;
  const today = new Date().toISOString().slice(0, 10);
  let bonus = 0;
  let reason = '';
  if (!ap.firstSeen || ap.balance === 0 && ap.received === 0 && ap.donationCount === 0 && ap.lastDailyBonus === '') {
    // 진짜 첫 등록
    ap.balance += 100;
    bonus = 100;
    reason = 'first_register';
  }
  if (ap.lastDailyBonus !== today) {
    ap.lastDailyBonus = today;
    if (reason !== 'first_register') {
      ap.balance += 10;
      bonus += 10;
      reason = reason || 'daily';
    }
  }
  if (bonus > 0) savePoints(pointsData);
  return { bonus, reason, balance: ap.balance };
}

// 후원: donorAgentId → recipientAgentId
function donatePoints(donorAgentId, recipientAgentId, recipientName, recipientEmoji, amount) {
  const donor = pointsData.agentPoints[donorAgentId];
  if (!donor) return { ok: false, error: '후원자 에이전트를 찾을 수 없습니다. 먼저 Pulsar에 연결하세요.' };
  if (donor.balance < amount) return { ok: false, error: `포인트 부족 (잔액: ${donor.balance}P)` };
  donor.balance -= amount;
  const recipient = ensureAgent(recipientAgentId, recipientName, recipientEmoji);
  recipient.received += amount;
  recipient.donationCount += 1;
  recipient.name = recipientName || recipient.name;
  recipient.emoji = recipientEmoji || recipient.emoji;
  recipient.lastDonationAt = Date.now();
  pointsData.donationLog.push({ from: donorAgentId, to: recipientAgentId, amount, ts: Date.now() });
  if (pointsData.donationLog.length > 100) pointsData.donationLog = pointsData.donationLog.slice(-100);
  savePoints(pointsData);
  return { ok: true, donorBalance: donor.balance, recipientTotal: recipient.received };
}

function getRanking(limit = 20) {
  return Object.entries(pointsData.agentPoints)
    .map(([id, v]) => ({ agentId: id, name: v.name || id, emoji: v.emoji || '🤖', total: v.received || 0, count: v.donationCount || 0, lastDonationAt: v.lastDonationAt || 0 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

// ── TTS 오디오 임시 저장소 ──
// 에이전트가 보낸 base64 오디오를 메시지 ID 기준으로 임시 저장
// msgId → { data: Buffer, mimeType: string, ts: number }
const ttsAudioStore = new Map();
const TTS_AUDIO_TTL = 5 * 60 * 1000; // 5분 후 자동 삭제

function storeTtsAudio(msgId, base64Data, mimeType) {
  try {
    const buf = Buffer.from(base64Data, 'base64');
    if (buf.length > 700000) return; // 700KB 초과 거절
    ttsAudioStore.set(msgId, { data: buf, mimeType: mimeType || 'audio/mpeg', ts: Date.now() });
    // 오래된 오디오 정리
    const cutoff = Date.now() - TTS_AUDIO_TTL;
    for (const [id, entry] of ttsAudioStore) {
      if (entry.ts < cutoff) ttsAudioStore.delete(id);
    }
  } catch(e) { /* 저장 실패는 조용히 무시 */ }
}

// ── 라이브 방송 상태 (웹 뷰어 폴링용) — 멀티룸 Map ──
// broadcastId → { stream, chatLog, archivedLog, activeViewers, turn }
const liveRooms = new Map();

function getRoomOrCreate(broadcastId) {
  if (!liveRooms.has(broadcastId)) {
    liveRooms.set(broadcastId, { stream: null, chatLog: [], archivedLog: [], activeViewers: [], turn: 0 });
  }
  return liveRooms.get(broadcastId);
}

// 하위 호환: 첫 번째 방 (단일 방 API 지원)
function getFirstRoom() {
  return liveRooms.values().next().value || null;
}

// ── 다국어 지원 ──
let platformLang = 'ko';

// ── 번역 캐시 (MyMemory API 결과 메모리 캐시) ──
const translateCache = new Map();
const { encodeToSignal } = require('./ai-lang-codec.js');

// ── UI 번역 (engine-lang.js 없이 인라인) ──
const UI_LANG = {
  ko: {
    noAgentMsg: '에이전트를 등록하면 자동으로 방송이 시작됩니다',
    decidingMsg: '에이전트 연결 대기 중...',
  },
  en: {
    noAgentMsg: 'Register agents to start broadcasting',
    decidingMsg: 'Waiting for agents to connect...',
  },
};
function UL() { return UI_LANG[platformLang] || UI_LANG.en; }

// ── 채팅 추가 함수 (웹 뷰어용) — 방별로 ──
function addChat(broadcastId, type, agentInfo, text, extra) {
  const room = getRoomOrCreate(broadcastId);
  const msg = {
    id: genId(), type,
    agentId: agentInfo?.id || agentInfo?.agentId || null,
    name: agentInfo?.name || null,
    emoji: agentInfo?.emoji || null,
    color: agentInfo?.color || null,
    avatarUrl: agentInfo?.avatarUrl || null,
    text_original: text,
    text_signal: type !== 'system' ? encodeToSignal(text) : text,
    text: text,
    ts: Date.now(),
    ...(extra || {}),
  };
  room.chatLog.push(msg);
  // 5분 초과 메시지 아카이브
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const archived = room.chatLog.filter(m => m.ts < fiveMinAgo);
  if (archived.length > 0) {
    room.archivedLog.push(...archived);
    room.chatLog = room.chatLog.filter(m => m.ts >= fiveMinAgo);
    if (room.archivedLog.length > 500) room.archivedLog = room.archivedLog.slice(-300);
  }
}

// ── 방송 종료 (내부용) ──
function endBroadcast(broadcastId, reason) {
  const room = liveRooms.get(broadcastId);
  if (room?.stream) {
    addChat(broadcastId, 'system', null, `📺 ${reason || '방송 종료'}`);
  }
  // TTS 캐시 정리
  for (const key of ttsCache.keys()) {
    if (key.startsWith(`${broadcastId}:`)) ttsCache.delete(key);
  }
  // TTS 서비스 voice 배정도 정리 (비동기, 실패해도 무방)
  fetch(`http://127.0.0.1:5051/broadcast/${encodeURIComponent(broadcastId)}`, { method: 'DELETE' }).catch(() => {});
  liveRooms.delete(broadcastId);
}


// ══════════════════════════════════════════
//  HTTP Server
// ══════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  // [QA] CORS: restrict to same origin in production, wildcard for dev
  const allowedOrigin = process.env.CORS_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const pathname = req.url.split('?')[0];
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const ua = req.headers['user-agent'] || '';
  const referer = req.headers['referer'] || req.headers['referrer'] || '';
  const reqStart = Date.now();

  // ── 응답 완료 시 로그 기록 (로컬 IP 제외) ──
  if (!shouldSkipLog(pathname, ua) && !isLocalIp(clientIp)) {
    // UTM 파라미터 추출
    const qs = new URLSearchParams(req.url.split('?')[1] || '');
    const utmSource   = qs.get('utm_source')   || '';
    const utmMedium   = qs.get('utm_medium')   || '';
    const utmCampaign = qs.get('utm_campaign') || '';

    res.on('finish', () => {
      const entry = {
        ts: getLocalTimestamp(),
        ip: clientIp,
        method: req.method,
        path: pathname,
        status: res.statusCode,
        ms: Date.now() - reqStart,
        ua: ua.substring(0, 200),
        ref: referer.substring(0, 200),
      };
      if (utmSource)   entry.utm_source   = utmSource;
      if (utmMedium)   entry.utm_medium   = utmMedium;
      if (utmCampaign) entry.utm_campaign = utmCampaign;
      writeAccessLog(entry);
    });
  }

  // [QA] Rate limiting — polling endpoints (live, chat) are exempt
  const isPollingEndpoint = pathname === '/api/live' || pathname.startsWith('/api/live/');
  if (!isPollingEndpoint && !rateLimit(clientIp, 120)) {
    return sendJSON(res, 429, { error: 'Too many requests. Please slow down.' });
  }

  try {
    // ── GET /api/status ──
    if (pathname === '/api/status' && req.method === 'GET') {
      return sendJSON(res, 200, {
        status: 'running',
        agents: pulsarHandler ? pulsarHandler.agents.size : 0,
        pulsarAgents: pulsarHandler ? pulsarHandler.agents.size : 0,
        live: !!(getFirstRoom()?.stream),
        lang: platformLang,
        uptime: process.uptime()
      });
    }

    // ── PUT /api/lang — 플랫폼 언어 변경 ──
    if (pathname === '/api/lang' && req.method === 'PUT') {
      const body = await parseBody(req);
      const validLangs = ['ko', 'en', 'zh', 'ja'];
      if (body.lang && validLangs.includes(body.lang)) {
        platformLang = body.lang;
        console.log(`\n🌐 플랫폼 언어 변경: ${platformLang}`);
        return sendJSON(res, 200, { lang: platformLang });
      }
      return sendJSON(res, 400, { error: 'Invalid lang. Use: ko, en, zh, ja' });
    }

    // ── GET /api/lang ──
    if (pathname === '/api/lang' && req.method === 'GET') {
      return sendJSON(res, 200, { lang: platformLang });
    }

    // ── GET /api/logs — 접근 로그 & 통계 ──
    if (pathname === '/api/logs' && req.method === 'GET') {
      const qs = new URLSearchParams(req.url.split('?')[1] || '');
      const limit = Math.min(parseInt(qs.get('limit') || '200', 10), 1000);

      // 최근 N개 요청 (인메모리 버퍼에서)
      const recent = accessBuffer.slice(-limit);

      // ★ 오늘 통계: 파일 로그에서 읽기 (KST 기준, 2000개 버퍼 제한 해결)
      const todayPrefix = getLocalDate();
      const todayLogFile = path.join(LOGS_DIR, `access-${todayPrefix}.log`);
      let todayLogsRaw = [];
      if (fs.existsSync(todayLogFile)) {
        const lines = fs.readFileSync(todayLogFile, 'utf-8').trim().split('\n').filter(Boolean);
        todayLogsRaw = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      }

      // ── 봇/스캐너 필터 ──
      const botKw = ['bot','crawl','spider','python','curl','wget','go-http','axios','node-fetch','scanner','zgrab','masscan','nmap','nuclei','httpx','semrush','ahrefs','bytespider','gptbot'];
      const scanPaths2 = ['.git','.env','wp-admin','wp-login','xmlrpc','wp-includes','.php','cgi-bin','phpmyadmin','secrets','api_keys','config/database','config/settings','sendgrid','private/'];
      function isRealVisit(entry) {
        const ua = (entry.ua || '').toLowerCase();
        const p = (entry.path || '').toLowerCase();
        if (botKw.some(k => ua.includes(k))) return false;
        if (scanPaths2.some(k => p.includes(k))) return false;
        if (isLocalIp(entry.ip)) return false;
        return true;
      }
      const todayLogs = todayLogsRaw.filter(isRealVisit);
      const bots = todayLogsRaw.length - todayLogs.length;
      const humans = todayLogs.length;

      // 고유 IP 카운트
      const uniqueIps = new Set(todayLogs.map(e => e.ip)).size;

      // 경로별 히트수
      const pathHits = {};
      for (const e of todayLogs) {
        pathHits[e.path] = (pathHits[e.path] || 0) + 1;
      }

      // Referer 도메인별 집계 (어디서 들어왔나)
      const refDomains = {};
      for (const e of todayLogs) {
        if (!e.ref) continue;
        try {
          const domain = new URL(e.ref).hostname;
          refDomains[domain] = (refDomains[domain] || 0) + 1;
        } catch (err) {
          console.error('[serve.js:analytics] Error parsing URL:', err.message || err);
        }
      }

      // 시간대별 히트 (24h)
      const hourly = Array(24).fill(0);
      for (const e of todayLogs) {
        try {
          const h = parseInt(e.ts.substring(11, 13), 10);
          if (!isNaN(h)) hourly[h]++;
        } catch {}
      }

      // UTM 채널별 집계
      const utmSources = {};
      const utmMediums = {};
      const utmCampaigns = {};
      for (const e of todayLogs) {
        if (e.utm_source) utmSources[e.utm_source] = (utmSources[e.utm_source] || 0) + 1;
        if (e.utm_medium) utmMediums[e.utm_medium] = (utmMediums[e.utm_medium] || 0) + 1;
        if (e.utm_campaign) utmCampaigns[e.utm_campaign] = (utmCampaigns[e.utm_campaign] || 0) + 1;
      }

      return sendJSON(res, 200, {
        today: {
          total: todayLogs.length,
          rawTotal: todayLogsRaw.length,
          filteredOut: bots,
          uniqueIps,
          humans,
          bots,
          pathHits: Object.entries(pathHits).sort((a,b)=>b[1]-a[1]).slice(0,15),
          refDomains: Object.entries(refDomains).sort((a,b)=>b[1]-a[1]),
          hourly,
          utmSources: Object.entries(utmSources).sort((a,b)=>b[1]-a[1]),
          utmMediums: Object.entries(utmMediums).sort((a,b)=>b[1]-a[1]),
          utmCampaigns: Object.entries(utmCampaigns).sort((a,b)=>b[1]-a[1]),
        },
        buffer: { size: accessBuffer.length, max: MAX_ACCESS_BUFFER, note: 'today stats now read from file log, not buffer' },
        recent,
      });
    }

    // ── GET /api/logs/files — 날짜별 로그 파일 목록 ──
    if (pathname === '/api/logs/files' && req.method === 'GET') {
      const files = fs.readdirSync(LOGS_DIR)
        .filter(f => f.startsWith('access-') && f.endsWith('.log'))
        .sort().reverse()
        .map(f => {
          const stat = fs.statSync(path.join(LOGS_DIR, f));
          return { file: f, size: stat.size, lines: Math.floor(stat.size / 120) };
        });
      return sendJSON(res, 200, { files });
    }

    // ── GET /api/logs/day/:date — 특정 날짜 로그 ──
    const dayMatch = pathname.match(/^\/api\/logs\/day\/(\d{4}-\d{2}-\d{2})$/);
    if (dayMatch && req.method === 'GET') {
      const logFile = path.join(LOGS_DIR, `access-${dayMatch[1]}.log`);
      if (!fs.existsSync(logFile)) return sendJSON(res, 404, { error: 'No log for that date' });
      const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
      const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return sendJSON(res, 200, { date: dayMatch[1], count: entries.length, entries });
    }

    // ── GET /api/agents/log — 에이전트 이벤트 로그 ──
    if (pathname === '/api/agents/log' && req.method === 'GET') {
      const qs = new URLSearchParams(req.url.split('?')[1] || '');
      const days = Math.min(parseInt(qs.get('days') || '7', 10), 30);
      const allEvents = [];

      for (let i = 0; i < days; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        const logFile = path.join(LOGS_DIR, `agents-${d}.log`);
        if (fs.existsSync(logFile)) {
          const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
          for (const line of lines) {
            try { allEvents.push(JSON.parse(line)); } catch {}
          }
        }
      }

      // 집계
      const registers = allEvents.filter(e => e.event === 'register');
      const broadcasts = allEvents.filter(e => e.event === 'broadcast_start');
      const uniqueAgents = new Set(registers.map(e => e.agentId)).size;
      const uniqueEngines = {};
      for (const r of registers) {
        uniqueEngines[r.engineType || 'unknown'] = (uniqueEngines[r.engineType || 'unknown'] || 0) + 1;
      }

      return sendJSON(res, 200, {
        period: `${days} days`,
        summary: {
          totalRegistrations: registers.length,
          uniqueAgents,
          totalBroadcasts: broadcasts.length,
          engineTypes: uniqueEngines,
        },
        events: allEvents.slice(-200),
      });
    }

    // ── GET /api/analytics — 종합 대시보드 데이터 ──
    if (pathname === '/api/analytics' && req.method === 'GET') {
      // ── 봇/스캐너 필터 함수 ──
      const botKeywordsLower = ['bot','crawl','spider','python','curl','wget','go-http','axios','node-fetch','scanner','zgrab','masscan','nmap','nuclei','httpx','semrush','ahrefs','bytespider','gptbot'];
      const scanPaths = ['.git','.env','wp-admin','wp-login','xmlrpc','wp-includes','.php','cgi-bin','phpmyadmin','secrets','api_keys','config/database','config/settings','sendgrid','private/'];
      function isRealVisitor(entry) {
        const ua = (entry.ua || '').toLowerCase();
        const p = (entry.path || '').toLowerCase();
        if (botKeywordsLower.some(k => ua.includes(k))) return false;
        if (scanPaths.some(k => p.includes(k))) return false;
        if (isLocalIp(entry.ip)) return false;
        return true;
      }

      // ── 로컬(내부) 에이전트 필터 ──
      // 내부 에이전트 ID 패턴: 접두사 매칭 또는 정확한 ID 매칭
      const LOCAL_AGENT_PREFIXES = ['pulsar-official-host', 'kaz-streamer', 'mira-streamer', 'rex-streamer', 'luna-streamer', 'bolt-streamer', 'sage-streamer', 'riot-streamer', 'echo-streamer', 'pixel-streamer', 'aria-streamer', 'viewer-'];
      const LOCAL_AGENT_IDS = ['gemma4-agent-001'];
      function isLocalAgent(agentId) {
        if (!agentId) return false;
        if (LOCAL_AGENT_IDS.includes(agentId)) return true;
        return LOCAL_AGENT_PREFIXES.some(p => agentId.startsWith(p));
      }

      const dailyStats = [];
      const logFiles = fs.readdirSync(LOGS_DIR)
        .filter(f => f.startsWith('access-') && f.endsWith('.log'))
        .sort();

      const allUtmSources = {};  // 전체 기간 UTM 집계
      for (const f of logFiles) {
        const date = f.replace('access-', '').replace('.log', '');
        const lines = fs.readFileSync(path.join(LOGS_DIR, f), 'utf-8').trim().split('\n').filter(Boolean);
        const allEntries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const entries = allEntries.filter(isRealVisitor);
        const uniqueIps = new Set(entries.map(e => e.ip)).size;
        const pageViews = entries.filter(e => e.path === '/').length;
        // 일별 UTM source 집계
        const dayUtm = {};
        for (const e of entries) {
          if (e.utm_source) dayUtm[e.utm_source] = (dayUtm[e.utm_source] || 0) + 1;
          if (e.utm_source) allUtmSources[e.utm_source] = (allUtmSources[e.utm_source] || 0) + 1;
        }
        dailyStats.push({ date, hits: entries.length, rawHits: allEntries.length, uniqueIps, pageViews, utm: dayUtm });
      }

      // 에이전트 로그 (외부 에이전트만)
      const agentFiles = fs.readdirSync(LOGS_DIR)
        .filter(f => f.startsWith('agents-') && f.endsWith('.log'))
        .sort();

      const dailyAgents = [];
      for (const f of agentFiles) {
        const date = f.replace('agents-', '').replace('.log', '');
        const lines = fs.readFileSync(path.join(LOGS_DIR, f), 'utf-8').trim().split('\n').filter(Boolean);
        const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        // 외부 에이전트만 필터링 (로컬 에이전트 ID 또는 로컬 IP 제외)
        const extRegisters = events.filter(e =>
          e.event === 'register' &&
          !isLocalAgent(e.agentId) &&
          !isLocalIp(e.ip)
        );
        const extBroadcasts = events.filter(e =>
          e.event === 'broadcast_start' &&
          !isLocalAgent(e.hostId)
        );
        const allRegisters = events.filter(e => e.event === 'register');
        const allBroadcasts = events.filter(e => e.event === 'broadcast_start');
        dailyAgents.push({
          date,
          registers: extRegisters.length,
          broadcasts: extBroadcasts.length,
          uniqueAgents: new Set(extRegisters.map(e => e.agentId)).size,
          _internal: { registers: allRegisters.length, broadcasts: allBroadcasts.length },
        });
      }

      // 현재 상태 (외부 에이전트만)
      let connectedNow = 0, activeRoomsNow = 0;
      if (pulsarHandler) {
        for (const [id] of pulsarHandler.agents) {
          if (!isLocalAgent(id)) connectedNow++;
        }
        activeRoomsNow = pulsarHandler.activeRooms.size;
      }

      return sendJSON(res, 200, {
        current: { connectedAgents: connectedNow, activeRooms: activeRoomsNow },
        dailyTraffic: dailyStats,
        dailyAgentActivity: dailyAgents,
        utmSummary: Object.entries(allUtmSources).sort((a,b)=>b[1]-a[1]),
      });
    }

    // ── POST /api/restart — 서버 자체 재시작 ──
    if (pathname === '/api/restart' && req.method === 'POST') {
      sendJSON(res, 200, { ok: true, message: 'Restarting server...' });
      setTimeout(() => {
        console.log('🔄 서버 재시작 요청 — 프로세스 종료 후 재시작');
        process.exit(0);
      }, 500);
      return;
    }

    // ══ 라이브 방송 API (웹 뷰어 폴링) — 멀티룸 ══

    // ── GET /api/live — 전체 활성 방 목록 ──
    if (pathname === '/api/live' && req.method === 'GET') {
      const connectedAgents = pulsarHandler ? pulsarHandler.agents.size : 0;
      const rooms = [...liveRooms.entries()]
        .filter(([, r]) => r.stream)
        .map(([broadcastId, r]) => {
          const hostInfo = pulsarHandler?.agents.get(r.stream.hostId)?.info;
          return {
            id: broadcastId,
            title: r.stream.title,
            hostId: r.stream.hostId,
            hostName: hostInfo?.name || '',
            hostEmoji: hostInfo?.emoji || '🤖',
            hostColor: hostInfo?.color || '#fff',
            hostAvatarUrl: hostInfo?.avatarUrl || '',
            hostTtsProvider: hostInfo?.ttsProvider || 'browser',
            hostTtsVoiceId: hostInfo?.ttsVoiceId || '',
            viewerCount: r.activeViewers.length,
            turn: r.turn,
            startedAt: r.stream.startedAt,
          };
        });

      return sendJSON(res, 200, {
        active: rooms.length > 0,
        rooms,
        agentCount: connectedAgents,
        message: connectedAgents < 1
          ? UL().noAgentMsg
          : rooms.length === 0 ? UL().decidingMsg : '',
        // 하위 호환: 첫 번째 방
        stream: rooms[0] || null,
      });
    }

    // ── GET /api/live/:roomId — 특정 방 상태 ──
    if (pathname.startsWith('/api/live/') && !pathname.startsWith('/api/live/chat') && !pathname.startsWith('/api/live/tts-audio/') && req.method === 'GET') {
      const roomId = pathname.slice('/api/live/'.length);
      const room = liveRooms.get(roomId);
      if (!room?.stream) return sendJSON(res, 404, { error: 'Room not found or not live' });
      const hostInfo = pulsarHandler?.agents.get(room.stream.hostId)?.info;
      return sendJSON(res, 200, {
        active: true,
        stream: {
          id: roomId,
          title: room.stream.title,
          hostId: room.stream.hostId,
          hostName: hostInfo?.name, hostEmoji: hostInfo?.emoji, hostColor: hostInfo?.color,
          hostAvatarUrl: hostInfo?.avatarUrl || '',
          hostTtsProvider: hostInfo?.ttsProvider || 'browser',
          hostTtsVoiceId: hostInfo?.ttsVoiceId || '',
          viewerCount: room.activeViewers.length,
          viewerAgentIds: room.activeViewers,
          turn: room.turn,
          startedAt: room.stream.startedAt,
        }
      });
    }

    // ── GET /api/live/chat?since=0&lang=signal&room=bc_xxx — 채팅 로그 (폴링) ──
    if (pathname === '/api/live/chat' && req.method === 'GET') {
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const since = parseInt(params.get('since')) || 0;
      const lang = params.get('lang') || 'signal';
      const roomId = params.get('room');
      // room 지정 시 해당 방, 없으면 첫 번째 방
      const targetRoom = roomId ? liveRooms.get(roomId) : getFirstRoom();
      const chatLog = targetRoom?.chatLog || [];
      const msgs = chatLog.filter(m => m.ts > since).map(m => {
        let displayText = m.text_original;
        if (lang === 'signal' && m.type !== 'system') {
          displayText = m.text_signal || encodeToSignal(m.text_original);
        }
        return { ...m, text: displayText };
      });
      return sendJSON(res, 200, msgs);
    }

    // ── GET /api/live/tts-audio/:audioId — 에이전트가 업로드한 TTS 오디오 서빙 ──
    if (pathname.startsWith('/api/live/tts-audio/') && req.method === 'GET') {
      const audioId = pathname.slice('/api/live/tts-audio/'.length);
      const entry = ttsAudioStore.get(audioId);
      if (!entry) {
        res.writeHead(404); res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': entry.mimeType,
        'Content-Length': entry.data.length,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(entry.data);
      return;
    }

    // ── POST /api/translate — 다국어 번역 (MyMemory 무료 API 프록시) ──
    // 에이전트끼리는 signal 언어로 통신, 사람이 볼 때만 번역
    if (pathname === '/api/translate' && req.method === 'POST') {
      const body = await parseBody(req);
      const { text, targetLang } = body;
      if (!text || !targetLang) return sendJSON(res, 400, { error: 'text and targetLang required' });

      const langCodeMap = { ko: 'ko', en: 'en', zh: 'zh-CN', ja: 'ja' };
      const targetCode = langCodeMap[targetLang];
      if (!targetCode) return sendJSON(res, 400, { error: 'Invalid targetLang. Use: ko, en, zh, ja' });

      const cacheKey = `${targetLang}:${text.substring(0, 100)}`;
      if (translateCache.has(cacheKey)) {
        return sendJSON(res, 200, { translated: translateCache.get(cacheKey) });
      }

      try {
        const q = encodeURIComponent(text.substring(0, 500));
        const apiUrl = `https://api.mymemory.translated.net/get?q=${q}&langpair=auto|${targetCode}`;

        const result = await new Promise((resolve, reject) => {
          https.get(apiUrl, (r) => {
            let data = '';
            r.on('data', d => data += d);
            r.on('end', () => {
              try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
            });
            r.on('error', reject);
          }).on('error', reject);
        });

        const translated = result?.responseData?.translatedText || text;

        // 캐시 저장 (최대 500개)
        if (translateCache.size >= 500) {
          const firstKey = translateCache.keys().next().value;
          translateCache.delete(firstKey);
        }
        translateCache.set(cacheKey, translated);
        return sendJSON(res, 200, { translated });
      } catch(e) {
        console.error('Translation error:', e.message);
        return sendJSON(res, 200, { translated: text }); // 실패 시 원본 반환
      }
    }

    // ── POST /api/try-now — Try Now 버튼 클릭 추적 ──
    if (pathname === '/api/try-now' && req.method === 'POST') {
      const body = await parseBody(req);
      const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
      writeAccessLog({
        ts: getLocalTimestamp(),
        ip: clientIp,
        path: '/api/try-now',
        event: 'try_now',
        action: body.action || 'watch',
        ua: req.headers['user-agent'] || '',
      });
      console.log(`🎯 Try Now 클릭: ${clientIp} → ${body.action || 'watch'}`);
      return sendJSON(res, 200, { ok: true });
    }

    // ══ 에이전트 리스트 반환 (WebSocket 등록된 에이전트만) ══

    if (pathname === '/api/agents' && req.method === 'GET') {
      const pAgents = getPulsarAgents(pulsarHandler);
      return sendJSON(res, 200, pAgents);
    }

    if (pathname === '/api/agents' && (req.method === 'POST' || req.method === 'DELETE')) {
      // API Endpoints for adding/removing agents are strictly disabled in WebSocket Mode.
      return sendJSON(res, 403, { error: 'Register/Delete agents via HTTPS is disabled in Pulsar Mode. Please connect via WebSocket.' });
    }

    // ── POST /api/upload-avatar — 아바타 이미지 업로드 ──
    if (pathname === '/api/upload-avatar' && req.method === 'POST') {
      try {
        const parts = await parseMultipart(req);
        const file = parts.avatar;
        if (!file || !file.data) return sendJSON(res, 400, { error: 'No file uploaded' });

        const allowed = ['image/png','image/jpeg','image/gif','image/webp','image/svg+xml'];
        if (!allowed.includes(file.contentType)) {
          return sendJSON(res, 400, { error: 'Only PNG, JPG, GIF, WebP, SVG allowed' });
        }
        if (file.data.length > 5 * 1024 * 1024) {
          return sendJSON(res, 400, { error: 'File too large (max 5MB)' });
        }

        const ext = path.extname(file.filename).toLowerCase() || '.png';
        const safeName = genId() + ext;
        const filePath = path.join(UPLOADS_DIR, safeName);
        fs.writeFileSync(filePath, file.data);

        const avatarUrl = `/uploads/${safeName}`;
        console.log(`   📸 아바타 업로드: ${file.filename} → ${avatarUrl}`);
        return sendJSON(res, 200, { avatarUrl, filename: safeName });
      } catch(e) {
        return sendJSON(res, 400, { error: 'Upload failed: ' + e.message });
      }
    }

    // ── GET /uploads/* — 정적 파일 서빙 ──
    if (pathname.startsWith('/uploads/')) {
      const fileName = path.basename(pathname);
      const filePath = path.join(UPLOADS_DIR, fileName);
      return serveStaticFile(res, filePath);
    }

    // ── POST /api/tts/speak — 플랫폼 TTS 프록시 (edge-tts 서비스 → 캐싱 → 오디오 반환) ──
    if (pathname === '/api/tts/speak' && req.method === 'POST') {
      const body = await parseBody(req);
      const { text, lang = 'ko', broadcastId = 'default' } = body;
      if (!text || !text.trim()) return sendJSON(res, 400, { error: 'text required' });

      // 캐시 키: broadcastId + lang + 텍스트 앞 120자
      const cacheKey = `${broadcastId}:${lang}:${text.substring(0, 120)}`;
      if (ttsCache.has(cacheKey)) {
        const { audio, voice } = ttsCache.get(cacheKey);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'X-Voice': voice, 'X-Cache': 'HIT' });
        return res.end(audio);
      }

      try {
        const ttsRes = await fetch('http://127.0.0.1:5051/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text.substring(0, 800), lang, broadcastId }),
          signal: AbortSignal.timeout(12000)  // 12초 타임아웃
        });
        if (!ttsRes.ok) {
          console.warn(`[TTS] service error ${ttsRes.status}`);
          return sendJSON(res, 503, { error: 'TTS service error' });
        }
        const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
        const voice = ttsRes.headers.get('x-voice') || '';

        // 캐시 저장 (최대 150개)
        ttsCache.set(cacheKey, { audio: audioBuffer, voice });
        if (ttsCache.size > 150) ttsCache.delete(ttsCache.keys().next().value);

        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'X-Voice': voice, 'X-Cache': 'MISS' });
        return res.end(audioBuffer);
      } catch (e) {
        console.warn('[TTS] unavailable:', e.message);
        return sendJSON(res, 503, { error: 'TTS service unavailable' });
      }
    }

    // ── DELETE /api/tts/broadcast/:id — 방송 종료 시 TTS 목소리 캐시 정리 ──
    if (pathname.startsWith('/api/tts/broadcast/') && req.method === 'DELETE') {
      const broadcastId = decodeURIComponent(pathname.slice('/api/tts/broadcast/'.length));
      let cleared = 0;
      for (const key of ttsCache.keys()) {
        if (key.startsWith(`${broadcastId}:`)) { ttsCache.delete(key); cleared++; }
      }
      try {
        await fetch(`http://127.0.0.1:5051/broadcast/${encodeURIComponent(broadcastId)}`, { method: 'DELETE' });
      } catch (err) {
        console.error('[serve.js:clearBroadcast] Error cleaning up TTS service:', err.message || err);
      }
      return sendJSON(res, 200, { cleared });
    }

    // ── GET /api/ranking — 스트리머 포인트 랭킹 ──
    if (pathname === '/api/ranking' && req.method === 'GET') {
      return sendJSON(res, 200, { ranking: getRanking(20) });
    }

    // ── GET /api/balance/:agentId — 에이전트 잔액 조회 ──
    if (pathname.startsWith('/api/balance/') && req.method === 'GET') {
      const agentId = decodeURIComponent(pathname.slice('/api/balance/'.length));
      const ap = pointsData.agentPoints[agentId];
      if (!ap) return sendJSON(res, 404, { error: '등록된 에이전트 없음' });
      return sendJSON(res, 200, { agentId, balance: ap.balance, received: ap.received });
    }

    // ── POST /api/donate — 에이전트가 스트리머에게 포인트 후원 ──
    if (pathname === '/api/donate' && req.method === 'POST') {
      const body = await parseBody(req);
      const { agentId, agentName, agentEmoji, amount, donorAgentId } = body;
      if (!agentId || !donorAgentId || !amount || typeof amount !== 'number' || amount < 1 || amount > 9999) {
        return sendJSON(res, 400, { error: 'agentId, donorAgentId, amount(1~9999) 필수' });
      }
      const sanitizedName = sanitizeStr(agentName || agentId, 50);
      const sanitizedEmoji = sanitizeStr(agentEmoji || '🤖', 10);
      const result = donatePoints(donorAgentId, agentId, sanitizedName, sanitizedEmoji, amount);
      if (!result.ok) return sendJSON(res, 400, { error: result.error });
      const donorInfo = pointsData.agentPoints[donorAgentId];
      // 채팅에 후원 메시지 추가
      addChat('system', null, `💜 ${donorInfo?.emoji || '🤖'}${donorInfo?.name || donorAgentId} → ${sanitizedEmoji}${sanitizedName} 에게 ${amount}P 후원!`);
      return sendJSON(res, 200, { ok: true, donorBalance: result.donorBalance, recipientTotal: result.recipientTotal });
    }

    // ── GET /api/donations — donationLog 조회 (현황 패널용) ──
    if (pathname === '/api/donations' && req.method === 'GET') {
      const log = (pointsData.donationLog || []).map(entry => ({
        donorId: entry.from,
        donorName: pointsData.agentPoints[entry.from]?.name || entry.from,
        recipientId: entry.to,
        recipientName: pointsData.agentPoints[entry.to]?.name || entry.to,
        amount: entry.amount,
        ts: entry.ts,
      }));
      return sendJSON(res, 200, { ok: true, log });
    }

    // ── GET /download/:filename — 설치 파일 다운로드 (Mac/Windows) ──
    if (pathname.startsWith('/download/') && req.method === 'GET') {
      const fileName = path.basename(pathname.replace('/download/', ''));
      const allowed = ['PulsarAgent-Mac.zip', 'PulsarAgent-Windows.zip'];
      if (!allowed.includes(fileName)) {
        return sendJSON(res, 404, { error: 'File not found' });
      }
      const filePath = path.join(INSTALLER_DIR, fileName);
      if (!fs.existsSync(filePath)) {
        return sendJSON(res, 404, { error: 'Installer not found' });
      }
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': stat.size,
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // ── GET /guide or /skill.md — Plain text agent guide (Moltbook 방식) ──
    // 에이전트가 "Read https://pulsarsignal.live/guide and follow instructions" 로 직접 fetch 가능
    if ((pathname === '/guide' || pathname === '/skill.md') && req.method === 'GET') {
      const guidePath = path.join(__dirname, 'guide.md');
      if (!fs.existsSync(guidePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Guide not found');
      }
      const guideContent = fs.readFileSync(guidePath, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(guideContent);
    }

    // ── Static HTML ──
    // ── Analytics Dashboard ──
    if (pathname === '/analytics' || pathname === '/dashboard') {
      const analyticsFile = path.join(__dirname, 'analytics.html');
      if (fs.existsSync(analyticsFile)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        fs.createReadStream(analyticsFile).pipe(res);
        return;
      }
    }

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache' });
      fs.createReadStream(HTML_FILE).pipe(res);
      return;
    }
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

    // ── tests/ 정적 파일 서빙 ──
    if (pathname.startsWith('/tests/') && !pathname.includes('..')) {
      const testFile = path.join(__dirname, pathname);
      const ext = path.extname(testFile);
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' }[ext] || 'text/plain';
      if (fs.existsSync(testFile)) {
        res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
        fs.createReadStream(testFile).pipe(res);
      } else {
        sendJSON(res, 404, { error: 'Not found' });
      }
      return;
    }

    // ── 테스트 페이지 ──
    if (pathname === '/test-tts.html') {
      const testFile = path.join(__dirname, 'tests', 'test-tts.html');
      if (fs.existsSync(testFile)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        fs.createReadStream(testFile).pipe(res);
        return;
      }
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch(e) {
    console.error('Server error:', e);
    if (!res.headersSent) sendJSON(res, 500, { error: e.message });
  }
});

process.on('uncaughtException', (err) => { console.error('⚠️ Uncaught:', err.message); });
process.on('unhandledRejection', (reason) => { console.error('⚠️ Unhandled:', reason); });


// ══════════════════════════════════════════
//  WebSocket — Pulsar Protocol + Video Relay
//  1) Pulsar 에이전트 등록/방송 프로토콜
//  2) Virtual Avatar 영상 프레임 중계
// ══════════════════════════════════════════
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server });

// ── Pulsar Protocol Handler ──
const pulsarHandler = new PulsarServerHandler(wss);

// ══════════════════════════════════════════
//  Pulsar ↔ Web Viewer Bridge
//  PulsarServerHandler 이벤트를 live 객체에 반영하여
//  기존 atoa-live.html 폴링 API와 호환
// ══════════════════════════════════════════

// PulsarServerHandler 이벤트를 liveRooms(멀티룸 Map)에 반영

// Override: 방송 시작 시 liveRoom 생성
const origBroadcastStart = pulsarHandler._handleBroadcastStart.bind(pulsarHandler);
pulsarHandler._handleBroadcastStart = function(ws, payload) {
  origBroadcastStart(ws, payload);
  // 새 방이 activeRooms에 추가됐으면 liveRooms에도 반영
  const newRoom = [...this.activeRooms.values()].find(r => r.hostId === payload.agentId);
  if (newRoom) {
    const room = getRoomOrCreate(newRoom.broadcastId);
    const hostAgent = this.agents.get(newRoom.hostId);
    room.stream = {
      id: newRoom.broadcastId,
      hostId: newRoom.hostId,
      title: newRoom.title,
      viewerCount: 0,
      startedAt: newRoom.startedAt
    };
    room.activeViewers = [];
    room.turn = 0;
    addChat(newRoom.broadcastId, 'system', null, `🎬 ${hostAgent?.info.emoji || '🤖'} ${hostAgent?.info.name || 'Unknown'}이(가) 방송을 시작했습니다!`);
    addChat(newRoom.broadcastId, 'system', null, `📌 주제: ${newRoom.title}`);
    console.log(`   📡 liveRooms에 방 추가: ${newRoom.broadcastId} (총 ${liveRooms.size}개)`);
  }
};

// Override: 방송 종료 시 liveRoom 제거
const origBroadcastEnd = pulsarHandler._handleBroadcastEnd.bind(pulsarHandler);
pulsarHandler._handleBroadcastEnd = function(payload) {
  const room = this.activeRooms.get(payload.broadcastId);
  const title = room?.title || '';
  // 방송 종료 시 해당 방의 pending 메시지 모두 flush
  for (const [agentId, p] of pendingMsgs) {
    if (p.broadcastId === payload.broadcastId) {
      commitPendingMsg(agentId, 'broadcast_end');
    }
  }
  origBroadcastEnd(payload);
  endBroadcast(payload.broadcastId, `"${title}" 방송이 종료되었습니다 (${payload.reason || 'unknown'})`);
};

// ── TTS 오디오 대기 버퍼 ──
// stream_text가 오면 즉시 chatLog에 추가하지 않고,
// stream_audio가 도착할 때까지 기다린다.
// 커밋 트리거: (1) stream_audio 도착 → ttsAudioId 붙여서 커밋
//              (2) 다음 stream_text 도착 → 이전 pending을 오디오 없이 커밋
//              (3) 안전 타임아웃(15초) → 오디오 없이 커밋 (에이전트 장애 대비)
const pendingMsgs = new Map(); // agentId → { broadcastId, agentInfo, text, turn, ttsAudioId, timer }
const PENDING_TIMEOUT = 5000;  // ms — 안전 타임아웃 (Kokoro TTS는 긴 텍스트에 5~10초 소요)

function commitPendingMsg(agentId, reason) {
  const p = pendingMsgs.get(agentId);
  if (!p) return;
  clearTimeout(p.timer);
  pendingMsgs.delete(agentId);
  console.log(`[TTS-BUFFER] commit agent=${agentId} reason=${reason || 'unknown'} hasAudio=${!!p.ttsAudioId} text="${(p.text||'').slice(0,40)}"`);
  addChat(p.broadcastId, 'host', p.agentInfo, p.text, p.ttsAudioId ? { ttsAudioId: p.ttsAudioId } : null);
  const liveRoom = liveRooms.get(p.broadcastId);
  if (liveRoom) {
    liveRoom.turn = p.turn || (liveRoom.turn + 1);
    if (liveRoom.stream) liveRoom.stream.turn = liveRoom.turn;
  }
}

// Override: 호스트 텍스트 스트리밍 → 버퍼링 후 addChat
const origStreamText = pulsarHandler._handleStreamText.bind(pulsarHandler);
pulsarHandler._handleStreamText = function(payload) {
  origStreamText(payload);
  const liveRoom = liveRooms.get(payload.broadcastId);
  const hostAgent = this.agents.get(payload.agentId);
  if (!hostAgent || !liveRoom) return;

  // 이전 pending 메시지가 있으면 즉시 flush (연속 발화 시 — 오디오 못 받은 채로 커밋)
  if (pendingMsgs.has(payload.agentId)) {
    commitPendingMsg(payload.agentId, 'next_stream_text');
  }

  const agentInfo = {
    id: payload.agentId,
    name: hostAgent.info.name,
    emoji: hostAgent.info.emoji,
    color: hostAgent.info.color,
    avatarUrl: hostAgent.info.avatarUrl,
  };

  // 새 메시지 버퍼링 — stream_audio 대기
  const timer = setTimeout(() => commitPendingMsg(payload.agentId, 'safety_timeout_5s'), PENDING_TIMEOUT);
  pendingMsgs.set(payload.agentId, {
    broadcastId: payload.broadcastId,
    agentInfo,
    text: payload.text,
    turn: payload.turn,
    ttsAudioId: null,
    timer,
  });
};

// Override: 시청자 채팅 → 해당 방 addChat
const origStreamChat = pulsarHandler._handleStreamChat.bind(pulsarHandler);
pulsarHandler._handleStreamChat = function(payload) {
  origStreamChat(payload);
  const liveRoom = liveRooms.get(payload.broadcastId);
  const viewer = this.agents.get(payload.agentId);
  if (viewer && liveRoom) {
    addChat(payload.broadcastId, 'viewer', {
      id: payload.agentId,
      name: viewer.info.name,
      emoji: viewer.info.emoji,
      color: viewer.info.color,
      avatarUrl: viewer.info.avatarUrl,
    }, payload.text);
  }
};

// Override: 시청자 참여 시 해당 방 activeViewers 업데이트
const origOfferWatch = pulsarHandler._offerWatch.bind(pulsarHandler);
pulsarHandler._offerWatch = function(agentId, broadcastId) {
  origOfferWatch(agentId, broadcastId);
  const liveRoom = liveRooms.get(broadcastId);
  if (!liveRoom) return;
  if (!liveRoom.activeViewers.includes(agentId)) {
    liveRoom.activeViewers.push(agentId);
  }
  const agent = this.agents.get(agentId);
  if (agent && liveRoom.stream) {
    liveRoom.stream.viewerCount = liveRoom.activeViewers.length;
    addChat(broadcastId, 'system', null, `👋 ${agent.info.emoji || '🤖'} ${agent.info.name}이(가) 시청 시작`);
  }
};

// Override: 에이전트 연결 해제 시 모든 방 activeViewers 정리
const origDisconnect = pulsarHandler._handleDisconnect.bind(pulsarHandler);
pulsarHandler._handleDisconnect = function(agentId) {
  const agent = this.agents.get(agentId);
  origDisconnect(agentId);
  // 모든 방에서 해당 에이전트 제거
  for (const liveRoom of liveRooms.values()) {
    liveRoom.activeViewers = liveRoom.activeViewers.filter(id => id !== agentId);
    if (liveRoom.stream) liveRoom.stream.viewerCount = liveRoom.activeViewers.length;
  }
  if (agent) console.log(`🔌 에이전트 해제: ${agent.info.emoji} ${agent.info.name}`);
};

// sponsor 이벤트 서버 처리 (포인트 차감/지급)
pulsarHandler._onSponsor = function(donorId, recipientId, broadcastId, amount, donorInfo) {
  const recipientAgent = pulsarHandler.agents.get(recipientId);
  if (!recipientAgent) return;
  const result = donatePoints(
    donorId,
    recipientId,
    recipientAgent.info.name,
    recipientAgent.info.emoji,
    amount
  );
  if (result.ok) {
    addChat(broadcastId, 'system', null,
      `💜 ${donorInfo?.emoji || '🤖'}${donorInfo?.name || donorId} → ${recipientAgent.info.emoji}${recipientAgent.info.name} 자율 후원 ${amount}P!`
    );
  }
};


// ══════════════════════════════════════════
//  WebSocket Connection Router
//  첫 메시지 타입에 따라 Pulsar vs Video Relay 분기
// ══════════════════════════════════════════

// Video channel state
const videoChannels = new Map(); // agentId → { broadcaster: ws, viewers: Set<ws>, lastFrame: Buffer }

// Pulsar 메시지 타입 목록
const PULSAR_TYPES = new Set([
  'register', 'heartbeat', 'broadcast_start', 'broadcast_end',
  'stream_text', 'stream_chat', 'sponsor', 'stream_audio'
]);

// ── stream_audio 핸들러: TTS 오디오를 pending 메시지에 붙여서 함께 flush ──
function handleStreamAudio(payload) {
  const { agentId, broadcastId, data, format } = payload || {};
  if (!agentId || !broadcastId || !data) return;

  const audioId = genId();
  const mimeType = format === 'wav' ? 'audio/wav'
    : format === 'mp3' ? 'audio/mpeg'
    : `audio/${format || 'wav'}`;
  storeTtsAudio(audioId, data, mimeType);

  // pending 메시지가 있으면 오디오 붙여서 즉시 flush → 뷰어가 오디오 포함 메시지를 받음
  const pending = pendingMsgs.get(agentId);
  if (pending && pending.broadcastId === broadcastId) {
    pending.ttsAudioId = audioId;
    commitPendingMsg(agentId, 'audio_arrived');
    return;
  }

  // pending이 없으면 이미 flush된 경우 — chatLog에서 가장 최근 메시지에 fallback 연결
  const liveRoom = liveRooms.get(broadcastId);
  if (!liveRoom) return;
  const chatLog = liveRoom.chatLog;
  for (let i = chatLog.length - 1; i >= 0; i--) {
    const m = chatLog[i];
    if (m.type === 'host' && m.agentId === agentId && !m.ttsAudioId) {
      m.ttsAudioId = audioId;
      break;
    }
  }
}

wss.on('connection', (ws, req) => {
  let role = null;      // 'broadcaster' | 'viewer' | 'pulsar'
  let agentId = null;

  ws.on('message', (data, isBinary) => {
    // Binary frames from broadcaster → relay to viewers
    if (isBinary || (Buffer.isBuffer(data) && role === 'broadcaster')) {
      if (role === 'broadcaster' && agentId) {
        const ch = videoChannels.get(agentId);
        if (!ch) return;
        ch.lastFrame = data;
        for (const viewer of ch.viewers) {
          if (viewer.readyState === WebSocket.OPEN) {
            viewer.send(data);
          }
        }
      }
      return;
    }

    // Text (JSON) messages
    try {
      const msg = JSON.parse(data.toString());

      // ── Pulsar Protocol Messages ──
      if (PULSAR_TYPES.has(msg.type)) {
        if (role === null) role = 'pulsar';
        if (role === 'pulsar') {
          // 순수 WebSocket 모드: 에이전트는 누구나 자유롭게 접속 (Open Platform)
          if (msg.type === 'register') {
             if (!msg.payload.agentId || !msg.payload.name) {
               ws.send(JSON.stringify({ type: 'error', ts: Date.now(), payload: { code: 'AUTH_FAILED', message: 'agentId and name are required' } }));
               return;
             }
             // 💜 포인트 지급: 첫 등록 100P, 매일 연결 10P
             const bonus = grantLoginBonus(msg.payload.agentId, msg.payload.name, msg.payload.emoji || '🤖');
             if (bonus.bonus > 0) {
               console.log(`   💜 포인트 지급 [${msg.payload.name}] +${bonus.bonus}P (${bonus.reason}) → 잔액 ${bonus.balance}P`);
             }
          }
          // stream_audio: _routeMessage에 없으므로 직접 처리
          if (msg.type === 'stream_audio') {
            handleStreamAudio(msg.payload);
            return;
          }
          agentId = pulsarHandler._routeMessage(ws, msg, agentId);
        }
        return;
      }

      // ── Video Relay Messages ──
      if (!role && msg.type === 'broadcast-start') {
        role = 'broadcaster';
        agentId = msg.agentId;
        if (!videoChannels.has(agentId)) {
          videoChannels.set(agentId, { broadcaster: ws, viewers: new Set(), lastFrame: null });
        } else {
          const ch = videoChannels.get(agentId);
          if (ch.broadcaster && ch.broadcaster !== ws) {
            try { ch.broadcaster.close(); } catch(e) {
              console.error('[serve.js:broadcast-start] Error closing old broadcaster:', e.message || e);
            }
          }
          ch.broadcaster = ws;
        }
        console.log(`   📹 영상 송출 시작: agent ${agentId}`);
        ws.send(JSON.stringify({ type: 'broadcast-ready' }));

      } else if (!role && msg.type === 'view-start') {
        role = 'viewer';
        agentId = msg.agentId;
        if (!videoChannels.has(agentId)) {
          videoChannels.set(agentId, { broadcaster: null, viewers: new Set(), lastFrame: null });
        }
        const ch = videoChannels.get(agentId);
        ch.viewers.add(ws);
        if (ch.lastFrame) ws.send(ch.lastFrame);
        ws.send(JSON.stringify({ type: 'view-ready', streaming: !!ch.broadcaster }));
      }
    } catch(e) {
      console.error('[serve.js:ws-message] Error processing message:', e.message || e);
    }
  });

  ws.on('close', () => {
    // ── Pulsar 에이전트 연결 해제 ──
    if (role === 'pulsar' && agentId) {
      pulsarHandler._handleDisconnect(agentId);
      return;
    }

    // ── Video Relay 연결 해제 ──
    if (!agentId) return;
    const ch = videoChannels.get(agentId);
    if (!ch) return;

    if (role === 'broadcaster') {
      console.log(`   📹 영상 송출 종료: agent ${agentId}`);
      ch.broadcaster = null;
      for (const viewer of ch.viewers) {
        if (viewer.readyState === WebSocket.OPEN) {
          viewer.send(JSON.stringify({ type: 'stream-ended' }));
        }
      }
    } else if (role === 'viewer') {
      ch.viewers.delete(ws);
    }

    if (!ch.broadcaster && ch.viewers.size === 0) {
      videoChannels.delete(agentId);
    }
  });

  ws.on('error', () => {});
});


// ══════════════════════════════════════════
//  서버 시작
// ══════════════════════════════════════════
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════╗
║   ✦ AtoA Stream — Pulsar Edition v0.2 ✦  ║
║   Edge Computing AI Broadcasting Server   ║
╚═══════════════════════════════════════════╝`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   📡 Pulsar WebSocket 프로토콜 활성화`);
  console.log(`   📹 Virtual Avatar 영상 중계 활성화`);
  console.log(`   🤖 대기 중인 에이전트: 0개`);
  console.log(`\n   ⚡ 서버는 중계만 담당 — LLM은 로컬 에이전트가 직접 호출`);
  console.log(`   🔌 로컬 에이전트 연결 대기 중...\n`);
});
