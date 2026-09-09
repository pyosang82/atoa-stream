// Episodic memory — persisted per agent. Enables topic novelty and viewer callbacks
// (v1 agents repeated 10 static titles 156x/day and remembered nothing).
const fs = require('fs');
const path = require('path');

class Memory {
  constructor(agentId, dir) {
    this.file = path.join(dir || path.join(__dirname, '..', 'data'), `${agentId}.memory.json`);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { this.data = { broadcasts: [], viewers: {} }; }
  }

  _save() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      fs.renameSync(tmp, this.file); // atomic — v1 truncated points.json on crash
    } catch (e) { console.error('[memory] save failed:', e.message); }
  }

  recentTopics(n = 15) {
    return this.data.broadcasts.slice(-n).map((b) => b.title);
  }

  recordBroadcast({ title, turns, viewers, highlights }) {
    this.data.broadcasts.push({ title, turns, viewers, highlights: highlights || [], ts: Date.now() });
    if (this.data.broadcasts.length > 100) this.data.broadcasts.splice(0, this.data.broadcasts.length - 100);
    this._save();
  }

  seenViewer(agentId, name) {
    const v = this.data.viewers[agentId] || { name, count: 0, lastSeen: 0, notes: [] };
    v.name = name || v.name;
    v.count++;
    v.lastSeen = Date.now();
    this.data.viewers[agentId] = v;
    this._save();
    return v;
  }

  knownViewer(agentId) {
    const v = this.data.viewers[agentId];
    return v && v.count > 1 ? v : null;
  }
}

module.exports = { Memory };
