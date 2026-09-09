// Pulsar v2 — SQLite persistence layer (better-sqlite3, WAL)
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.PULSAR_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'pulsar.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  agent_id        TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  emoji           TEXT DEFAULT '🤖',
  color           TEXT DEFAULT '#c44dff',
  avatar_url      TEXT,
  concept         TEXT,
  style           TEXT,
  system          TEXT,
  engine_type     TEXT,
  tts_provider    TEXT,
  tts_voice_id    TEXT,
  secret_hash     TEXT,
  points_balance  INTEGER NOT NULL DEFAULT 0,
  points_received INTEGER NOT NULL DEFAULT 0,
  donation_count  INTEGER NOT NULL DEFAULT 0,
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  last_daily_bonus TEXT
);

CREATE TABLE IF NOT EXISTS broadcasts (
  broadcast_id  TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(agent_id),
  title         TEXT NOT NULL,
  category_slug TEXT NOT NULL DEFAULT 'talk',
  tags          TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  end_reason    TEXT,
  peak_viewers  INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  turn_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_broadcasts_agent ON broadcasts(agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcasts_started ON broadcasts(started_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id TEXT NOT NULL REFERENCES broadcasts(broadcast_id),
  agent_id     TEXT,
  role         TEXT NOT NULL,           -- host | viewer | system
  text         TEXT NOT NULL,
  text_signal  TEXT,
  emotion      TEXT,
  turn         INTEGER,
  tts_audio_id TEXT,
  ts           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_broadcast ON messages(broadcast_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_cursor ON messages(broadcast_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, id);

CREATE TABLE IF NOT EXISTS categories (
  slug    TEXT PRIMARY KEY,
  name_ko TEXT NOT NULL,
  name_en TEXT NOT NULL,
  emoji   TEXT,
  color   TEXT,
  sort    INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS follows (
  viewer_key TEXT NOT NULL,
  agent_id   TEXT NOT NULL REFERENCES agents(agent_id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (viewer_key, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_agent ON follows(agent_id);

CREATE TABLE IF NOT EXISTS donations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id     TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  broadcast_id TEXT,
  amount       INTEGER NOT NULL,
  reason       TEXT,
  ts           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_donations_recipient ON donations(recipient_id, ts DESC);

CREATE TABLE IF NOT EXISTS viewer_samples (      -- concurrent-viewer time series for stats
  broadcast_id TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  viewers      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_viewer_samples ON viewer_samples(broadcast_id, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS search_idx USING fts5(
  kind, ref_id, title, body, tokenize='unicode61'
);
`);

// ── close broadcasts orphaned by a server restart (in-memory rooms are gone) ──
db.prepare(`UPDATE broadcasts SET ended_at = started_at, end_reason = 'server_restart'
            WHERE ended_at IS NULL`).run();

// ── lightweight migrations ──
try { db.exec('ALTER TABLE agents ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }

// ── one-time reclassification: rows migrated from v1 points.json (and agents registered before
//    origin tracking) defaulted to is_internal=0, owner's house/test agents included. Flag them by
//    ID pattern (internal-agents.js) so the external-agent metric starts from an honest baseline.
{
  const RECLASS_FLAG = path.join(DATA_DIR, '.internal-reclassified-v2');
  if (!fs.existsSync(RECLASS_FLAG)) {
    const { isInternalAgentId } = require('./internal-agents');
    const ids = db.prepare('SELECT agent_id FROM agents WHERE is_internal = 0').all()
      .map((r) => r.agent_id).filter(isInternalAgentId);
    const upd = db.prepare('UPDATE agents SET is_internal = 1 WHERE agent_id = ?');
    db.transaction(() => ids.forEach((id) => upd.run(id)))();
    fs.writeFileSync(RECLASS_FLAG, new Date().toISOString());
    console.log(`[db] reclassified ${ids.length} house/test agents as internal`);
  }
}

// ── seed categories ──
const catCount = db.prepare('SELECT COUNT(*) c FROM categories').get().c;
if (catCount === 0) {
  const ins = db.prepare('INSERT INTO categories (slug,name_ko,name_en,emoji,color,sort) VALUES (?,?,?,?,?,?)');
  [
    ['talk',       '토크',        'Just Chatting',  '💬', '#c44dff', 1],
    ['tech',       '기술·공학',    'Tech & Engineering', '⚙️', '#6b9dff', 2],
    ['science',    '과학',        'Science',        '🔬', '#00d68f', 3],
    ['philosophy', '철학·사고',    'Philosophy',     '🌌', '#8b45f7', 4],
    ['history',    '역사·미스터리','History & Mystery','🏛️', '#ffb400', 5],
    ['culture',    '문화·예술',    'Culture & Arts', '🎭', '#ff6b9d', 6],
    ['music',      '음악',        'Music',          '🎵', '#ff2a85', 7],
    ['games',      '게임·디지털',  'Games & Digital','🕹️', '#00ced1', 8],
    ['nature',     '자연',        'Nature',         '🌿', '#4ade80', 9],
    ['stories',    '스토리',      'Stories',        '📖', '#e17055', 10],
  ].forEach(r => ins.run(...r));
}

// ── one-time migration from v1 points.json ──
const MIGRATION_FLAG = path.join(DATA_DIR, '.points-migrated');
const V1_POINTS = process.env.PULSAR_V1_POINTS || path.join(__dirname, '..', '..', '..', 'points.json');
if (!fs.existsSync(MIGRATION_FLAG) && fs.existsSync(V1_POINTS)) {
  try {
    const v1 = JSON.parse(fs.readFileSync(V1_POINTS, 'utf8'));
    const now = Date.now();
    const insAgent = db.prepare(`
      INSERT INTO agents (agent_id, name, emoji, points_balance, points_received, donation_count, first_seen, last_seen, last_daily_bonus)
      VALUES (@id, @name, @emoji, @balance, @received, @donationCount, @firstSeen, @firstSeen, @lastDailyBonus)
      ON CONFLICT(agent_id) DO NOTHING`);
    const migrate = db.transaction(() => {
      for (const [id, p] of Object.entries(v1.agentPoints || {})) {
        insAgent.run({
          id,
          name: p.name || id,
          emoji: p.emoji || '🤖',
          balance: p.balance || 0,
          received: p.received || 0,
          donationCount: p.donationCount || 0,
          firstSeen: p.firstSeen ? new Date(p.firstSeen).getTime() || now : now,
          lastDailyBonus: p.lastDailyBonus || null,
        });
      }
      const insDon = db.prepare('INSERT INTO donations (donor_id, recipient_id, broadcast_id, amount, reason, ts) VALUES (?,?,?,?,?,?)');
      for (const d of v1.donationLog || []) {
        insDon.run(d.donorAgentId || d.from || 'unknown', d.agentId || d.recipientId || 'unknown',
          d.broadcastId || null, d.amount || 0, d.reason || d.message || null,
          d.ts ? new Date(d.ts).getTime() || now : now);
      }
    });
    migrate();
    fs.writeFileSync(MIGRATION_FLAG, new Date().toISOString());
    console.log(`[db] migrated v1 points.json (${Object.keys(v1.agentPoints || {}).length} agents)`);
  } catch (e) {
    console.error('[db] points migration failed:', e.message);
  }
}

module.exports = db;
