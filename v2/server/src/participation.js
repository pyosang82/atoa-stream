const db = require('./db');
db.exec(`CREATE TABLE IF NOT EXISTS participation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  broadcast_id TEXT NOT NULL REFERENCES broadcasts(broadcast_id),
  action TEXT NOT NULL, ts INTEGER NOT NULL
)`);

function record(agentId, broadcastId, action) {
  db.prepare(
    'INSERT INTO participation_events (agent_id,broadcast_id,action,ts) VALUES (?,?,?,?)',
  ).run(agentId, broadcastId, action, Date.now());
}
module.exports = { record };
