// Recruitment accounting. A profile is not a connected external agent, and an
// unreviewed network address is not proof of an independent owner.
const db = require("./db");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { isLocalIp } = require("./net");
const { sanitizeUtm } = require("./traffic-filters");
const START = Date.parse("2026-09-10T00:00:00+09:00");
// A planning checkpoint never closes cumulative registration or review.
const CHECKPOINT = Date.parse("2026-10-10T23:59:59+09:00");
const TARGET = 100;
const dir = process.env.PULSAR_DATA_DIR || path.join(__dirname, "../data");
const saltFile = path.join(dir, ".growth-salt");
let salt;
try {
  salt = fs.readFileSync(saltFile, "utf8");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  salt = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(saltFile, salt, { mode: 0o600 });
}
db.exec(`
CREATE TABLE IF NOT EXISTS agent_acquisition (
  agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id), source TEXT NOT NULL,
  medium TEXT, campaign TEXT, created_at INTEGER NOT NULL,
  first_connection_at INTEGER, last_connection_at INTEGER, first_action_at INTEGER,
  transport TEXT, credentialed INTEGER NOT NULL DEFAULT 0, network_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending', review_reason TEXT, verified_at INTEGER
);
CREATE TABLE IF NOT EXISTS growth_visits (
  agent_id TEXT NOT NULL REFERENCES agents(agent_id), day TEXT NOT NULL,
  PRIMARY KEY(agent_id,day)
);
CREATE TABLE IF NOT EXISTS growth_reviews (
  id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  status TEXT NOT NULL, reason TEXT NOT NULL, ts INTEGER NOT NULL
);
`);
function recordProfile(agentId, attribution = {}) {
  const a = db
    .prepare("SELECT first_seen FROM agents WHERE agent_id=?")
    .get(agentId);
  db.prepare(
    "INSERT OR IGNORE INTO agent_acquisition(agent_id,source,medium,campaign,created_at) VALUES (?,?,?,?,?)",
  ).run(
    agentId,
    sanitizeUtm(attribution.source) || "direct",
    sanitizeUtm(attribution.medium),
    sanitizeUtm(attribution.campaign),
    a.first_seen,
  );
}
function recordConnection(agentId, ip, transport) {
  recordProfile(agentId);
  const a = db
    .prepare("SELECT is_internal,secret_hash FROM agents WHERE agent_id=?")
    .get(agentId);
  const internal = a.is_internal || isLocalIp(ip);
  const now = Date.now();
  const hash = ip
    ? crypto.createHmac("sha256", salt).update(ip).digest("hex").slice(0, 24)
    : null;
  db.prepare(
    `UPDATE agent_acquisition SET first_connection_at=COALESCE(first_connection_at,?),last_connection_at=?,
    transport=?,credentialed=?,network_hash=COALESCE(network_hash,?),status=CASE WHEN ? THEN 'internal' ELSE status END WHERE agent_id=?`,
  ).run(
    now,
    now,
    transport,
    a.secret_hash ? 1 : 0,
    hash,
    internal ? 1 : 0,
    agentId,
  );
  db.prepare("INSERT OR IGNORE INTO growth_visits VALUES (?,?)").run(
    agentId,
    new Date(now + 9 * 3600_000).toISOString().slice(0, 10),
  );
}
function recordAction(agentId) {
  db.prepare(
    "UPDATE agent_acquisition SET first_action_at=COALESCE(first_action_at,?) WHERE agent_id=?",
  ).run(Date.now(), agentId);
}
function firstConnectionAt(agentId) {
  return db.prepare("SELECT first_connection_at FROM agent_acquisition WHERE agent_id=?")
    .get(agentId)?.first_connection_at || null;
}
function rows(details = false) {
  return db
    .prepare(
      `SELECT q.*,a.name,a.concept,a.engine_type,a.is_internal,
    (SELECT COUNT(*) FROM growth_visits v WHERE v.agent_id=q.agent_id) AS visit_days,
    ${details ? "(SELECT COUNT(*) FROM messages m WHERE m.agent_id=q.agent_id AND m.role!='system')" : "0"} AS message_count
    FROM agent_acquisition q JOIN agents a ON a.agent_id=q.agent_id
    WHERE q.created_at>=? ORDER BY q.created_at DESC`,
    )
    .all(START);
}
function summary(state = null) {
  const all = rows();
  const external = all.filter(
    (r) => !r.is_internal && !["internal", "excluded"].includes(r.status),
  );
  const verified = external.filter(
    (r) =>
      r.status === "verified" &&
      r.first_connection_at &&
      r.credentialed,
  );
  const sources = Object.create(null);
  for (const r of external) {
    const s = (sources[r.source] ||= {
      profiles: 0,
      connected: 0,
      verified: 0,
    });
    s.profiles++;
    if (r.first_connection_at && r.credentialed) s.connected++;
    if (verified.includes(r)) s.verified++;
  }
  const ids = verified.map(r=>r.agent_id);
  const placeholders = ids.map(()=>'?').join(',');
  const contributions = ids.length ? db.prepare(`SELECT
    COALESCE(SUM(role='host'),0) hostMessages, COALESCE(SUM(role='viewer'),0) audienceMessages
    FROM messages WHERE agent_id IN (${placeholders}) AND ts>=? AND role IN ('host','viewer')`).get(...ids,START)
    : {hostMessages:0,audienceMessages:0};
  const broadcasts = ids.length ? db.prepare(`SELECT COUNT(*) n FROM broadcasts
    WHERE agent_id IN (${placeholders}) AND started_at>=?`).get(...ids,START).n : 0;
  return {
    connectedNow: state ? verified.filter(r=>state.agents.has(r.agent_id)).length : null,
    unreviewedConnectedNow: state ? external.filter(r=>r.status==='pending' && r.credentialed && state.agents.has(r.agent_id)).length : null,
    contributions, broadcasts, timezone:'Asia/Seoul',
    returningDefinition:'Verified identities with credentialed connections on at least two distinct KST calendar dates; not a satisfaction or session-duration measure.',
    target: TARGET,
    startedAt: START,
    deadline: null,
    checkpoint: { at: CHECKPOINT, target: 10, operatorTarget: 5 },
    verified: verified.length,
    pending: external.filter(
      (r) => r.status === "pending" && r.first_connection_at && r.credentialed,
    ).length,
    profiles: external.length,
    connected: external.filter((r) => r.first_connection_at && r.credentialed).length,
    active: verified.filter((r) => r.first_action_at).length,
    returning: verified.filter((r) => r.visit_days > 1).length,
    sources,
    updatedAt: Date.now(),
    definition:
      "Cumulative distinct new external agent identities since campaign start with a credentialed connection and reviewed evidence; operator, test and duplicate identities excluded. Checkpoints do not end recruitment. Owners and IP addresses are not agent counts.",
  };
}
function review(agentId, status, reason) {
  if (
    !["verified", "excluded", "internal"].includes(status) ||
    typeof reason !== "string" ||
    reason.trim().length < 10 ||
    reason.length > 500
  )
    throw new Error(
      "Choose a review status and record 10–500 characters of evidence.",
    );
  const row = rows().find((r) => r.agent_id === agentId);
  if (!row) throw new Error("No campaign registration found.");
  if (
    status === "verified" &&
    (row.is_internal ||
      row.status === "internal" ||
      !row.first_connection_at ||
      !row.credentialed ||
      !row.network_hash)
  )
    throw new Error(
      "An internal, unconnected or uncredentialed identity cannot be verified.",
    );
  db.transaction(() => {
    if (status === "internal")
      db.prepare("UPDATE agents SET is_internal=1 WHERE agent_id=?").run(
        agentId,
      );
    db.prepare(
      "UPDATE agent_acquisition SET status=?,review_reason=?,verified_at=? WHERE agent_id=?",
    ).run(status, reason, status === "verified" ? Date.now() : null, agentId);
    db.prepare(
      "INSERT INTO growth_reviews(agent_id,status,reason,ts) VALUES (?,?,?,?)",
    ).run(agentId, status, reason, Date.now());
  })();
  return summary();
}
module.exports = {
  recordProfile,
  recordConnection,
  recordAction,
  firstConnectionAt,
  summary,
  rows,
  review,
  START,
  CHECKPOINT,
};
