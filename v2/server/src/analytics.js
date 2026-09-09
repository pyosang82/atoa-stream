// GA-style analytics: server-side hit logging + client event beacons, own SQLite DB.
// Privacy: raw IPs are never stored (salted SHA-256 only); 90-day retention sweep.
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { AI_BOTS, detectBot, isScannerPath, sanitizeUtm } = require('./traffic-filters');
const { clientIp, isLocalIp } = require('./net');

const DATA_DIR = process.env.PULSAR_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'analytics.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  ip_hash TEXT,
  viewer_key TEXT,
  path TEXT NOT NULL,
  ref TEXT, ref_domain TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  ua TEXT,
  bot_name TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  is_local INTEGER NOT NULL DEFAULT 0,
  status INTEGER, ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_hits_day ON hits(day);
CREATE INDEX IF NOT EXISTS idx_hits_bot ON hits(is_bot, day);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  viewer_key TEXT,
  session_id TEXT,
  event TEXT NOT NULL,
  route TEXT,
  broadcast_id TEXT,
  channel_id TEXT,
  value INTEGER,
  ref TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_day ON events(day, event);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`);

// stable salt (created once) — hashes are consistent but IPs are unrecoverable
let SALT = db.prepare("SELECT v FROM meta WHERE k='ip_salt'").get()?.v;
if (!SALT) {
  SALT = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT INTO meta (k,v) VALUES ('ip_salt', ?)").run(SALT);
}

// ── one-time backfill: reclassify scanner hits already stored as real visitors, drop junk UTMs ──
{
  const KEY = 'mig_scanner_backfill_v1';
  if (!db.prepare('SELECT v FROM meta WHERE k = ?').get(KEY)) {
    const rows = db.prepare('SELECT id, path, utm_source, utm_medium, utm_campaign FROM hits').all();
    const markScan = db.prepare("UPDATE hits SET is_bot = 1, bot_name = 'scanner' WHERE id = ?");
    const fixUtm = db.prepare('UPDATE hits SET utm_source = ?, utm_medium = ?, utm_campaign = ? WHERE id = ?');
    let scans = 0, utms = 0;
    db.transaction(() => {
      for (const r of rows) {
        if (isScannerPath(r.path)) { markScan.run(r.id); scans++; }
        const c = [sanitizeUtm(r.utm_source), sanitizeUtm(r.utm_medium), sanitizeUtm(r.utm_campaign)];
        if (c[0] !== r.utm_source || c[1] !== r.utm_medium || c[2] !== r.utm_campaign) { fixUtm.run(...c, r.id); utms++; }
      }
      db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run(KEY, new Date().toISOString());
    })();
    console.log(`[analytics] backfill: ${scans} scanner hits reclassified, ${utms} junk UTM rows cleaned`);
  }
}

// ── owner-only access ──
const ADMIN_KEY_FILE = path.join(DATA_DIR, 'admin-key.txt');
let ADMIN_KEY;
try { ADMIN_KEY = fs.readFileSync(ADMIN_KEY_FILE, 'utf8').trim(); } catch { ADMIN_KEY = null; }
if (!ADMIN_KEY) {
  ADMIN_KEY = 'pk_' + crypto.randomBytes(18).toString('hex');
  fs.writeFileSync(ADMIN_KEY_FILE, ADMIN_KEY + '\n', { mode: 0o600 });
  console.log(`[analytics] admin key generated at ${ADMIN_KEY_FILE}`);
}

function checkAdmin(req, u) {
  const k = req.headers['x-pulsar-admin'] || u.searchParams.get('key');
  return typeof k === 'string' && k.length === ADMIN_KEY.length
    && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY));
}

// viewer_keys belonging to the owner's own browsers (marked on successful admin auth)
function getOwnerKeys() {
  try { return JSON.parse(db.prepare("SELECT v FROM meta WHERE k='owner_keys'").get()?.v || '[]'); }
  catch { return []; }
}
function markOwnerKey(vk) {
  if (!vk) return;
  const keys = getOwnerKeys();
  if (!keys.includes(vk)) {
    keys.push(vk);
    db.prepare("INSERT INTO meta (k,v) VALUES ('owner_keys',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
      .run(JSON.stringify(keys.slice(-20)));
  }
}

// SQL fragment helpers for exclusion filters
function exKeysFrag(col, keys) {
  if (!keys.length) return { sql: '', params: [] };
  return { sql: ` AND (${col} IS NULL OR ${col} NOT IN (${keys.map(() => '?').join(',')}))`, params: keys };
}
function exChannelsFrag(col, ids) {
  if (!ids.length) return { sql: '', params: [] };
  return { sql: ` AND (${col} IS NULL OR ${col} NOT IN (${ids.map(() => '?').join(',')}))`, params: ids };
}

const kstDay = (ts) => new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
const hashIp = (ip) => ip ? crypto.createHash('sha256').update(SALT + ip).digest('hex').slice(0, 24) : null;

function refDomain(ref) {
  try { return new URL(ref).hostname.replace(/^www\./, '') || null; } catch { return null; }
}

const insHit = db.prepare(`INSERT INTO hits (ts, day, ip_hash, viewer_key, path, ref, ref_domain,
  utm_source, utm_medium, utm_campaign, ua, bot_name, is_bot, is_local, status, ms)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

function logHit(req, u, viewerKey, status, ms) {
  try {
    const ts = Date.now();
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    // vulnerability-scanner paths are never real visitors, whatever the UA claims
    const bot = isScannerPath(u.pathname) ? 'scanner' : detectBot(ua);
    const ip = clientIp(req);
    const ref = String(req.headers.referer || '').slice(0, 500) || null;
    insHit.run(ts, kstDay(ts), hashIp(ip), viewerKey || null, u.pathname.slice(0, 200),
      ref, ref ? refDomain(ref) : null,
      sanitizeUtm(u.searchParams.get('utm_source')), sanitizeUtm(u.searchParams.get('utm_medium')),
      sanitizeUtm(u.searchParams.get('utm_campaign')),
      ua, bot, bot ? 1 : 0, isLocalIp(ip) ? 1 : 0, status, ms);
  } catch (e) { console.error('[analytics] logHit:', e.message); }
}

const EVENT_WHITELIST = new Set([
  'page_view', 'watch_start', 'watch_ping', 'watch_end', 'replay_view', 'replay_play',
  'follow', 'unfollow', 'search', 'signal_toggle', 'tts_toggle', 'connect_copy', 'session_start',
]);

const insEvent = db.prepare(`INSERT INTO events (ts, day, viewer_key, session_id, event, route,
  broadcast_id, channel_id, value, ref, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

function logEvents(viewerKey, body) {
  const list = Array.isArray(body?.events) ? body.events.slice(0, 20) : [];
  let n = 0;
  for (const e of list) {
    if (!EVENT_WHITELIST.has(e.event)) continue;
    const ts = Date.now();
    try {
      insEvent.run(ts, kstDay(ts), viewerKey || null,
        String(e.sessionId || '').slice(0, 40) || null,
        e.event,
        String(e.route || '').slice(0, 200) || null,
        String(e.broadcastId || '').slice(0, 40) || null,
        String(e.channelId || '').slice(0, 80) || null,
        Number.isFinite(e.value) ? Math.max(0, Math.min(3600, Math.floor(e.value))) : null,
        String(e.ref || '').slice(0, 500) || null,
        e.meta ? JSON.stringify(e.meta).slice(0, 500) : null);
      n++;
    } catch { /* skip bad row */ }
  }
  return n;
}

// ── aggregates ──
// ex: { keys: viewer_keys to exclude (owner traffic), channels: channel_ids to exclude (own agents) }
function overview(days = 14, ex = { keys: [], channels: [] }) {
  const since = kstDay(Date.now() - days * 86400_000);
  const k = exKeysFrag('viewer_key', ex.keys);
  const daily = db.prepare(`
    SELECT day,
      COUNT(DISTINCT CASE WHEN event='page_view' THEN viewer_key END) AS visitors,
      SUM(event='page_view') AS pageviews,
      COUNT(DISTINCT session_id) AS sessions,
      COALESCE(SUM(CASE WHEN event='watch_ping' THEN value END),0) AS watch_seconds,
      SUM(event='follow') AS follows
    FROM events WHERE day >= ?${k.sql} GROUP BY day ORDER BY day`)
    .all(since, ...k.params);
  const totals = db.prepare(`
    SELECT COUNT(DISTINCT CASE WHEN event='page_view' THEN viewer_key END) AS visitors,
      COALESCE(SUM(event='page_view'),0) AS pageviews,
      COUNT(DISTINCT session_id) AS sessions,
      COALESCE(SUM(CASE WHEN event='watch_ping' THEN value END),0) AS watch_seconds
    FROM events WHERE day >= ?${k.sql}`).get(since, ...k.params);
  const guideHits = db.prepare(`
    SELECT COUNT(*) c FROM hits WHERE day >= ? AND path IN ('/guide','/skill.md') AND is_local = 0`).get(since).c;
  return { daily, totals, guideHits, since };
}

function acquisition(days = 14, ex = { keys: [], channels: [] }) {
  const since = kstDay(Date.now() - days * 86400_000);
  const k = exKeysFrag('viewer_key', ex.keys);
  const referrers = db.prepare(`
    SELECT ref_domain AS domain, COUNT(*) AS hits, COUNT(DISTINCT ip_hash) AS uniques
    FROM hits WHERE day >= ? AND is_bot = 0 AND is_local = 0 AND ref_domain IS NOT NULL
      AND ref_domain != 'pulsarsignal.live'${k.sql}
    GROUP BY ref_domain ORDER BY hits DESC LIMIT 15`).all(since, ...k.params);
  const utm = db.prepare(`
    SELECT utm_source AS source, utm_campaign AS campaign, COUNT(*) AS hits
    FROM hits WHERE day >= ? AND utm_source IS NOT NULL${k.sql}
    GROUP BY utm_source, utm_campaign ORDER BY hits DESC LIMIT 15`).all(since, ...k.params);
  const direct = db.prepare(`
    SELECT COUNT(*) c FROM hits WHERE day >= ? AND is_bot = 0 AND is_local = 0 AND ref IS NULL AND path = '/'${k.sql}`)
    .get(since, ...k.params).c;
  return { referrers, utm, direct, since };
}

function content(days = 14, ex = { keys: [], channels: [] }) {
  const since = kstDay(Date.now() - days * 86400_000);
  const k = exKeysFrag('viewer_key', ex.keys);
  const c = exChannelsFrag('channel_id', ex.channels);
  const routes = db.prepare(`
    SELECT route, SUM(event='page_view') AS views, COUNT(DISTINCT viewer_key) AS uniques
    FROM events WHERE day >= ? AND event='page_view' AND route IS NOT NULL${k.sql}
    GROUP BY route ORDER BY views DESC LIMIT 15`).all(since, ...k.params);
  const channels = db.prepare(`
    SELECT channel_id AS channelId,
      COALESCE(SUM(CASE WHEN event='watch_ping' THEN value END),0) AS watch_seconds,
      COUNT(DISTINCT CASE WHEN event='watch_start' THEN session_id END) AS watch_sessions
    FROM events WHERE day >= ? AND channel_id IS NOT NULL${k.sql}${c.sql}
    GROUP BY channel_id ORDER BY watch_seconds DESC LIMIT 15`).all(since, ...k.params, ...c.params);
  const searches = db.prepare(`
    SELECT json_extract(meta,'$.q') AS q, COUNT(*) AS n
    FROM events WHERE day >= ? AND event='search' AND meta IS NOT NULL${k.sql}
    GROUP BY q ORDER BY n DESC LIMIT 10`).all(since, ...k.params);
  return { routes, channels, searches, since };
}

function crawlers(days = 14) {
  const since = kstDay(Date.now() - days * 86400_000);
  const byBot = db.prepare(`
    SELECT bot_name AS bot, COUNT(*) AS hits, MAX(ts) AS lastSeen
    FROM hits WHERE day >= ? AND is_bot = 1 AND bot_name NOT IN ('script','no-ua','headless','scanner')
    GROUP BY bot_name ORDER BY hits DESC LIMIT 20`).all(since)
    .map((r) => ({ ...r, ai: AI_BOTS.has(r.bot) }));
  const daily = db.prepare(`
    SELECT day, SUM(CASE WHEN bot_name IN (${[...AI_BOTS].map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS ai_hits,
      COUNT(*) AS all_hits
    FROM hits WHERE day >= ? AND is_bot = 1 GROUP BY day ORDER BY day`).all(...AI_BOTS, since);
  const topPaths = db.prepare(`
    SELECT path, COUNT(*) AS hits FROM hits WHERE day >= ? AND is_bot = 1
    GROUP BY path ORDER BY hits DESC LIMIT 10`).all(since);
  return { byBot, daily, topPaths, since };
}

function realtime(state) {
  const fiveMin = Date.now() - 5 * 60_000;
  const active = db.prepare(`
    SELECT COUNT(DISTINCT viewer_key) c FROM events WHERE ts >= ?`).get(fiveMin).c;
  const watching = [];
  for (const meta of state.webClients.values()) {
    if (meta.subscribedRoom) watching.push(meta.subscribedRoom);
  }
  return {
    connectedWeb: state.webClients.size,
    activeLast5m: active,
    watchingByRoom: watching.reduce((acc, r) => { acc[r] = (acc[r] || 0) + 1; return acc; }, {}),
  };
}

// ── retention: keep 90 days ──
setInterval(() => {
  try {
    const cutoff = kstDay(Date.now() - 90 * 86400_000);
    db.prepare('DELETE FROM hits WHERE day < ?').run(cutoff);
    db.prepare('DELETE FROM events WHERE day < ?').run(cutoff);
  } catch (e) { console.error('[analytics] retention sweep:', e.message); }
}, 6 * 3600_000).unref();

module.exports = { logHit, logEvents, overview, acquisition, content, crawlers, realtime, checkAdmin, markOwnerKey, getOwnerKeys };
