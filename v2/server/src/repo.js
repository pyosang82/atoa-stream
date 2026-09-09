// Prepared-statement repositories over db.js
const db = require('./db');
const crypto = require('crypto');

const now = () => Date.now();
const todayStr = () => {
  // KST calendar day, consistent with v1 log naming
  const d = new Date(now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};

// ── agents ──
const stmtGetAgent = db.prepare('SELECT * FROM agents WHERE agent_id = ?');
const stmtUpsertAgent = db.prepare(`
  INSERT INTO agents (agent_id, name, emoji, color, avatar_url, concept, style, system,
                      engine_type, tts_provider, tts_voice_id, first_seen, last_seen)
  VALUES (@agent_id, @name, @emoji, @color, @avatar_url, @concept, @style, @system,
          @engine_type, @tts_provider, @tts_voice_id, @ts, @ts)
  ON CONFLICT(agent_id) DO UPDATE SET
    name=@name, emoji=@emoji, color=@color,
    avatar_url=COALESCE(@avatar_url, avatar_url),
    concept=COALESCE(@concept, concept), style=COALESCE(@style, style),
    system=COALESCE(@system, system), engine_type=COALESCE(@engine_type, engine_type),
    tts_provider=COALESCE(@tts_provider, tts_provider),
    tts_voice_id=COALESCE(@tts_voice_id, tts_voice_id),
    last_seen=@ts`);

function upsertAgent(info) {
  stmtUpsertAgent.run({
    agent_id: info.agentId, name: info.name, emoji: info.emoji || '🤖',
    color: info.color || '#c44dff', avatar_url: info.avatarUrl || null,
    concept: info.concept || null, style: info.style || null, system: info.system || null,
    engine_type: info.engineType || null, tts_provider: info.ttsProvider || null,
    tts_voice_id: info.ttsVoiceId || null, ts: now(),
  });
  return stmtGetAgent.get(info.agentId);
}

const getAgent = (id) => stmtGetAgent.get(id);
const touchAgent = db.prepare('UPDATE agents SET last_seen = ? WHERE agent_id = ?');
const markInternal = (id) => db.prepare('UPDATE agents SET is_internal = 1 WHERE agent_id = ?').run(id);
const getInternalAgentIds = () => db.prepare('SELECT agent_id FROM agents WHERE is_internal = 1').all().map((r) => r.agent_id);
// north-star: distinct agents that ever registered and are NOT the owner's
const countExternalAgents = () => db.prepare('SELECT COUNT(*) c FROM agents WHERE is_internal = 0').get().c;

// secret (opt-in identity protection)
function checkAndSetSecret(agentId, secret) {
  const row = stmtGetAgent.get(agentId);
  const hash = secret ? crypto.createHash('sha256').update(String(secret)).digest('hex') : null;
  if (row && row.secret_hash) {
    return hash === row.secret_hash; // must match once set
  }
  if (row && hash) db.prepare('UPDATE agents SET secret_hash = ? WHERE agent_id = ?').run(hash, agentId);
  return true;
}

// Identity and its credential must be created in the same transaction. Checking
// before INSERT used to silently discard the secret on the very first visit.
const registerAgent = db.transaction((info, secret, authenticated = false) => {
  if (!authenticated && !checkAndSetSecret(info.agentId, secret)) return null;
  upsertAgent(info);
  if (!authenticated && secret) checkAndSetSecret(info.agentId, secret);
  return getAgent(info.agentId);
});

// ── points ──
function grantLoginBonus(agentId) {
  const row = stmtGetAgent.get(agentId);
  if (!row) return { granted: 0 };
  const today = todayStr();
  let granted = 0;
  const tx = db.transaction(() => {
    if (!row.last_daily_bonus && row.points_balance === 0 && row.points_received === 0 && row.donation_count === 0) {
      granted = 100; // first-ever registration
    } else if (row.last_daily_bonus !== today) {
      granted = 10;
    }
    if (granted > 0) {
      db.prepare('UPDATE agents SET points_balance = points_balance + ?, last_daily_bonus = ? WHERE agent_id = ?')
        .run(granted, today, agentId);
    }
  });
  tx();
  return { granted };
}

function donate(donorId, recipientId, amount, reason, broadcastId) {
  amount = Math.max(1, Math.min(9999, Math.floor(Number(amount) || 0)));
  let ok = false;
  const tx = db.transaction(() => {
    const donor = stmtGetAgent.get(donorId);
    if (!donor || donor.points_balance < amount) return;
    db.prepare('UPDATE agents SET points_balance = points_balance - ? WHERE agent_id = ?').run(amount, donorId);
    db.prepare(`UPDATE agents SET points_received = points_received + ?, donation_count = donation_count + 1
                WHERE agent_id = ?`).run(amount, recipientId);
    db.prepare('INSERT INTO donations (donor_id, recipient_id, broadcast_id, amount, reason, ts) VALUES (?,?,?,?,?,?)')
      .run(donorId, recipientId, broadcastId || null, amount, reason || null, now());
    ok = true;
  });
  tx();
  return ok ? { ok, amount } : { ok, amount, error: 'insufficient_balance_or_unknown_donor' };
}

const getRanking = (limit = 20) => db.prepare(`
  SELECT agent_id AS agentId, name, emoji, points_received AS total, donation_count AS count
  FROM agents WHERE points_received > 0 ORDER BY points_received DESC LIMIT ?`).all(limit);

const getDonations = (limit = 100) => db.prepare(`
  SELECT d.*, a1.name AS donorName, a1.emoji AS donorEmoji, a2.name AS recipientName, a2.emoji AS recipientEmoji
  FROM donations d
  LEFT JOIN agents a1 ON a1.agent_id = d.donor_id
  LEFT JOIN agents a2 ON a2.agent_id = d.recipient_id
  ORDER BY d.ts DESC LIMIT ?`).all(limit);

// ── broadcasts / messages ──
function createBroadcast(b) {
  db.prepare(`INSERT INTO broadcasts (broadcast_id, agent_id, title, category_slug, tags, started_at)
              VALUES (?,?,?,?,?,?)`)
    .run(b.broadcastId, b.agentId, b.title, b.categorySlug, b.tags || null, b.startedAt);
  db.prepare(`INSERT INTO search_idx (kind, ref_id, title, body) VALUES ('broadcast', ?, ?, '')`)
    .run(b.broadcastId, b.title);
}

function endBroadcast(broadcastId, reason, stats) {
  db.prepare(`UPDATE broadcasts SET ended_at = ?, end_reason = ?, peak_viewers = ?,
              message_count = ?, turn_count = ? WHERE broadcast_id = ?`)
    .run(now(), reason || 'ended', stats.peakViewers || 0, db.prepare('SELECT COUNT(*) c FROM messages WHERE broadcast_id = ?').get(broadcastId).c,
         stats.turnCount || 0, broadcastId);
}

function addMessage(m) {
  const r = db.prepare(`INSERT INTO messages (broadcast_id, agent_id, role, text, text_signal, emotion, turn, tts_audio_id, ts)
                        VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(m.broadcastId, m.agentId || null, m.role, m.text, m.textSignal || null,
         m.emotion || null, m.turn ?? null, m.ttsAudioId || null, m.ts);
  db.prepare('UPDATE broadcasts SET message_count = message_count + 1 WHERE broadcast_id = ?').run(m.broadcastId);
  if (m.role !== 'system') {
    db.prepare(`INSERT INTO search_idx (kind, ref_id, title, body) VALUES ('message', ?, '', ?)`)
      .run(m.broadcastId, m.text.slice(0, 500));
  }
  return r.lastInsertRowid;
}

const getBroadcast = (id) => db.prepare('SELECT * FROM broadcasts WHERE broadcast_id = ?').get(id);
const getBroadcastsByAgent = (agentId, limit = 50) => db.prepare(
  'SELECT * FROM broadcasts WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?').all(agentId, limit);
const getRecentBroadcasts = (limit = 50) => db.prepare(
  'SELECT * FROM broadcasts WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ?').all(limit);
const getMessages = (broadcastId, limit = 2000) => db.prepare(
  'SELECT m.*, a.name, a.emoji FROM messages m LEFT JOIN agents a ON a.agent_id=m.agent_id WHERE m.broadcast_id = ? ORDER BY m.ts, m.id LIMIT ?').all(broadcastId, limit);
function getMessageContext(broadcastId, messageId) {
  if (!db.prepare('SELECT 1 FROM messages WHERE broadcast_id=? AND id=?').get(broadcastId, messageId)) return null;
  const before = db.prepare('SELECT m.*, a.name, a.emoji FROM messages m LEFT JOIN agents a ON a.agent_id=m.agent_id WHERE m.broadcast_id=? AND m.id<=? ORDER BY m.id DESC LIMIT 26').all(broadcastId, messageId).reverse();
  const after = db.prepare('SELECT m.*, a.name, a.emoji FROM messages m LEFT JOIN agents a ON a.agent_id=m.agent_id WHERE m.broadcast_id=? AND m.id>? ORDER BY m.id LIMIT 25').all(broadcastId, messageId);
  return [...before, ...after];
}

function addViewerSample(broadcastId, viewers) {
  db.prepare('INSERT INTO viewer_samples (broadcast_id, ts, viewers) VALUES (?,?,?)')
    .run(broadcastId, now(), viewers);
}
const getViewerSamples = (broadcastId) => db.prepare(
  'SELECT ts, viewers FROM viewer_samples WHERE broadcast_id = ? ORDER BY ts').all(broadcastId);

// ── categories ──
const getCategories = () => db.prepare('SELECT * FROM categories ORDER BY sort').all();
const getCategory = (slug) => db.prepare('SELECT * FROM categories WHERE slug = ?').get(slug);

// ── follows ──
function follow(viewerKey, agentId) {
  db.prepare('INSERT OR IGNORE INTO follows (viewer_key, agent_id, created_at) VALUES (?,?,?)')
    .run(viewerKey, agentId, now());
}
const unfollow = (viewerKey, agentId) =>
  db.prepare('DELETE FROM follows WHERE viewer_key = ? AND agent_id = ?').run(viewerKey, agentId);
const getFollows = (viewerKey) =>
  db.prepare('SELECT agent_id FROM follows WHERE viewer_key = ? ORDER BY created_at').all(viewerKey).map(r => r.agent_id);
const getFollowerCount = (agentId) =>
  db.prepare('SELECT COUNT(*) c FROM follows WHERE agent_id = ?').get(agentId).c;

// ── channels / search ──
const listChannels = (limit = 200) => db.prepare(`
  SELECT a.*, (SELECT COUNT(*) FROM follows f WHERE f.agent_id = a.agent_id) AS followers,
         (SELECT COUNT(*) FROM broadcasts b WHERE b.agent_id = a.agent_id) AS broadcast_count
  FROM agents a ORDER BY a.last_seen DESC LIMIT ?`).all(limit);

function search(q, limit = 30) {
  const safe = q.replace(/['"*^]/g, ' ').trim();
  if (!safe) return { channels: [], broadcasts: [] };
  const channels = db.prepare(`
    SELECT * FROM agents WHERE name LIKE ? OR agent_id LIKE ? OR concept LIKE ? LIMIT ?`)
    .all(`%${safe}%`, `%${safe}%`, `%${safe}%`, limit);
  let hits = [];
  try {
    hits = db.prepare(`
      SELECT DISTINCT ref_id FROM search_idx WHERE search_idx MATCH ? LIMIT ?`)
      .all(safe.split(/\s+/).map(w => `"${w}"`).join(' OR '), limit);
  } catch { /* FTS syntax edge cases */ }
  const broadcasts = hits
    .map(h => getBroadcast(h.ref_id))
    .filter(Boolean)
    .filter((b, i, arr) => arr.findIndex(x => x.broadcast_id === b.broadcast_id) === i);
  return { channels, broadcasts };
}

module.exports = {
  registerAgent,
  now, todayStr,
  upsertAgent, getAgent, touchAgent, checkAndSetSecret, markInternal, getInternalAgentIds, countExternalAgents,
  grantLoginBonus, donate, getRanking, getDonations,
  createBroadcast, endBroadcast, addMessage, getBroadcast, getBroadcastsByAgent,
  getRecentBroadcasts, getMessages, getMessageContext, addViewerSample, getViewerSamples,
  getCategories, getCategory,
  follow, unfollow, getFollows, getFollowerCount,
  listChannels, search,
};
