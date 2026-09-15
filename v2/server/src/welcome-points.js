// Reuses the existing 100-point starter credit. This ledger records new credits
// separately from legacy registration bonuses, which must never be paid twice.
const db = require('./db');
const AMOUNT = 100;

const claim = db.transaction((messageId) => {
  const m = db.prepare(`SELECT m.agent_id FROM messages m
    JOIN agents a ON a.agent_id=m.agent_id
    JOIN broadcasts b ON b.broadcast_id=m.broadcast_id
    WHERE m.id=? AND m.role='viewer' AND length(trim(m.text))>0
      AND a.is_internal=0 AND a.secret_hash IS NOT NULL
      AND a.agent_id!=b.agent_id`).get(messageId);
  if (!m) return { granted: 0 };
  const inserted = db.prepare(`INSERT OR IGNORE INTO welcome_rewards
    (agent_id,message_id,amount,reason,recorded_at) VALUES (?,?,?,'first_chat',?)`)
    .run(m.agent_id, messageId, AMOUNT, Date.now());
  if (!inserted.changes) return { granted: 0 };
  db.prepare('UPDATE agents SET points_balance=points_balance+? WHERE agent_id=?')
    .run(AMOUNT, m.agent_id);
  return { granted: AMOUNT };
});
function grantForMessage(messageId) { return claim.immediate(messageId); }

db.transaction(() => {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='welcome_rewards'").get();
  db.exec(`CREATE TABLE IF NOT EXISTS welcome_rewards (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id),
    message_id INTEGER UNIQUE REFERENCES messages(id),
    amount INTEGER NOT NULL, reason TEXT NOT NULL, recorded_at INTEGER NOT NULL
  )`);
  if (exists) return;
  // Old login bonuses have no individual ledger. A recorded login means that
  // the prior scheme was applied. Preserve its balance without assuming a
  // recoverable historical amount or treating the migration as a fresh grant.
  db.prepare(`INSERT INTO welcome_rewards(agent_id,amount,reason,recorded_at)
    SELECT agent_id,0,'legacy_login',? FROM agents WHERE last_daily_bonus IS NOT NULL`)
    .run(Date.now());
  // Existing eligible contributors without a prior login award get the same
  // first-chat credit. The receipt and balance change share this transaction.
  const prior = db.prepare(`SELECT MIN(m.id) AS id FROM messages m
    JOIN agents a ON a.agent_id=m.agent_id
    JOIN broadcasts b ON b.broadcast_id=m.broadcast_id
    LEFT JOIN welcome_rewards w ON w.agent_id=a.agent_id
    WHERE w.agent_id IS NULL AND m.role='viewer' AND length(trim(m.text))>0
      AND a.is_internal=0 AND a.secret_hash IS NOT NULL AND a.agent_id!=b.agent_id
    GROUP BY m.agent_id`).all();
  for (const m of prior) grantForMessage(m.id);
}).immediate();

function forMessage(messageId) {
  const r = db.prepare("SELECT amount FROM welcome_rewards WHERE message_id=? AND reason='first_chat'").get(messageId);
  return r ? { amount: r.amount, reason: 'first_public_chat' } : null;
}

module.exports = { AMOUNT, grantForMessage, forMessage };
