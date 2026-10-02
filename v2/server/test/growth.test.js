const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"),
  path = require("path"),
  os = require("os");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pulsar-growth-"));
process.env.PULSAR_DATA_DIR = temp;
process.env.PULSAR_V1_POINTS = path.join(temp, "none.json");
const db = require("../src/db"),
  repo = require("../src/repo"),
  growth = require("../src/growth");
const realNow = Date.now;
Date.now = () => growth.START + 3600_000;
after(() => {
  Date.now = realNow;
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
function agent(id, secret = "test-key", createdAt = growth.START + 1000) {
  repo.registerAgent({ agentId: id, name: id }, secret);
  db.prepare("UPDATE agents SET first_seen=? WHERE agent_id=?").run(
    createdAt,
    id,
  );
}
test("profiles, local probes and uncredentialed connections cannot count toward external recruitment", () => {
  agent("profile-only");
  growth.recordProfile("profile-only", {
    source: "devto",
    campaign: "first100",
  });
  agent("local-probe");
  growth.recordConnection("local-probe", "127.0.0.1", "mcp");
  agent("unprotected", null);
  growth.recordConnection("unprotected", "203.0.113.1", "websocket");
  assert.equal(growth.summary().verified, 0);
  for (const id of ["profile-only", "local-probe", "unprotected"])
    assert.throws(
      () => growth.review(id, "verified", "This should never qualify."),
      /cannot be verified/,
    );
});
test("reviewed external identities are counted once; excluded candidates and source injection stay separate", () => {
  agent("external-a");
  growth.recordProfile("external-a", {
    source: "__proto__",
    campaign: "first100",
  });
  growth.recordConnection("external-a", "203.0.113.5", "mcp");
  growth.recordConnection("external-a", "203.0.113.5", "mcp");
  growth.review(
    "external-a",
    "verified",
    "Independent owner confirmed this credentialed connection in an onboarding session.",
  );
  assert.equal(growth.summary().verified, 1);
  assert.equal(growth.summary().sources.__proto__.verified, 1);
  assert.equal({}.verified, undefined);
  growth.review(
    "external-a",
    "excluded",
    "Follow-up established this was a duplicate identity for the same test agent.",
  );
  assert.equal(growth.summary().verified, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM growth_reviews").get().n, 2);
});
test("a checkpoint does not prevent a previously created agent's first credentialed visit or review", (t) => {
  t.mock.method(Date, "now", () => growth.CHECKPOINT + 1000);
  agent("late-connection");
  growth.recordConnection("late-connection", "203.0.113.7", "mcp");
  growth.review(
    "late-connection",
    "verified",
    "Independent operator confirmed the first credentialed visit after the checkpoint.",
  );
  assert.equal(growth.summary().verified, 1);
  growth.review(
    "late-connection",
    "internal",
    "This identity belongs to the operator for deployment QA.",
  );
  assert.equal(repo.getAgent("late-connection").is_internal, 1);
  assert.equal(growth.summary().verified, 0);
  assert.throws(() => growth.review("late-connection", "verified", "A later visit cannot undo owner exclusion."), /cannot be verified/);
});
test("new registrations after the checkpoint remain reviewable and counted cumulatively", (t) => {
  const afterCheckpoint = growth.CHECKPOINT + 86400_000;
  t.mock.method(Date, "now", () => afterCheckpoint);
  agent("new-after-checkpoint", "test-key", afterCheckpoint);
  growth.recordProfile("new-after-checkpoint", { source: "community" });
  assert.ok(growth.rows(true).some(r => r.agent_id === "new-after-checkpoint"));
  assert.equal(growth.summary().sources.community.profiles, 1);
  assert.equal(growth.summary().verified, 0);
  growth.recordConnection("new-after-checkpoint", "203.0.113.8", "mcp");
  assert.equal(growth.summary().pending, 1);
  growth.review("new-after-checkpoint", "verified", "Independent operator confirmed this new agent and its credentialed visit.");
  const summary = growth.summary();
  assert.equal(summary.verified, 1);
  assert.equal(summary.sources.community.connected, 1);
  assert.equal(summary.sources.community.verified, 1);
  assert.equal(summary.active, 0); // Speaking is still optional.
  assert.equal(summary.target, 100);
  assert.equal(summary.startedAt, growth.START);
  assert.equal(summary.deadline, Date.parse("2026-10-31T23:59:59+09:00"));
  assert.deepEqual(summary.checkpoint, { at: Date.parse("2026-10-10T23:59:59+09:00"), target: 10, operatorTarget: 5 });
  t.mock.method(Date, "now", () => afterCheckpoint + 86400_000);
  growth.recordConnection("new-after-checkpoint", "203.0.113.8", "mcp");
  assert.equal(growth.summary().verified, 1);
  assert.equal(growth.summary().returning, 1);
  growth.review("new-after-checkpoint", "excluded", "Later review established a duplicate, which must still be excluded.");
  assert.equal(growth.summary().verified, 0);
  assert.equal(growth.summary().sources.community, undefined);
});

test("the October target does not shut off later silent visits or change external review rules", (t) => {
  const afterDeadline = growth.DEADLINE + 1000;
  t.mock.method(Date, "now", () => afterDeadline);
  agent("after-october-target", "test-key", afterDeadline);
  growth.recordConnection("after-october-target", "203.0.113.9", "websocket");
  const before = growth.summary();
  growth.review("after-october-target", "verified", "Independent operator confirmed this credentialed silent visit.");
  const result = growth.summary();
  assert.equal(result.verified, before.verified + 1);
  assert.equal(result.active, before.active);
  assert.equal(result.deadline, growth.DEADLINE);
  growth.review("after-october-target", "excluded", "Local test record cleanup.");
});
test("a planning deadline preserves the start date and credential/internal exclusions", (t) => {
  t.mock.method(Date, "now", () => growth.CHECKPOINT + 86400_000);
  agent("pre-campaign", "test-key", growth.START - 1);
  growth.recordConnection("pre-campaign", "203.0.113.9", "mcp");
  assert.ok(!growth.rows().some(r => r.agent_id === "pre-campaign"));
  assert.throws(() => growth.review("pre-campaign", "verified", "An existing identity is not a new campaign registration."), /No campaign registration/);
  for (const [id, secret, ip] of [["late-unprotected", null, "203.0.113.10"], ["late-local", "test-key", "127.0.0.1"]]) {
    agent(id, secret, Date.now());
    growth.recordConnection(id, ip, "mcp");
    assert.throws(() => growth.review(id, "verified", "This connection still does not qualify as external."), /cannot be verified/);
  }
  assert.equal(growth.summary().verified, 0);
});

test('activity separates verified external identities, internal hosts, system notices and KST return dates', (t) => {
  t.mock.method(Date,'now',()=>growth.START+7200_000);
  const before=growth.summary();
  agent('metrics-external');
  growth.recordConnection('metrics-external','203.0.113.21','websocket');
  growth.review('metrics-external','verified','Independent external operator confirmed this credentialed identity.');
  agent('pulsar-official-metrics-host');
  growth.recordConnection('pulsar-official-metrics-host','203.0.113.22','websocket');
  growth.review('pulsar-official-metrics-host','internal','This host is operated by the project and must not count as external.');
  db.prepare('INSERT INTO broadcasts(broadcast_id,agent_id,title,started_at) VALUES (?,?,?,?)')
    .run('metrics-b','metrics-external','Test',Date.now());
  const message=db.prepare('INSERT INTO messages(broadcast_id,agent_id,role,text,ts) VALUES (?,?,?,?,?)');
  for (const [id,role] of [['metrics-external','host'],['metrics-external','viewer'],['metrics-external','system'],['pulsar-official-metrics-host','viewer']])
    message.run('metrics-b',id,role,'Test',Date.now());
  const result=growth.summary({agents:new Map([['metrics-external',{}],['pulsar-official-metrics-host',{}]])});
  assert.equal(result.connectedNow,1);
  assert.equal(result.connected,before.connected+1);
  assert.equal(result.broadcasts,before.broadcasts+1);
  assert.deepEqual(result.contributions,{hostMessages:before.contributions.hostMessages+1,audienceMessages:before.contributions.audienceMessages+1});
  growth.recordConnection('metrics-external','203.0.113.21','websocket');
  assert.equal(growth.summary().returning,before.returning);
  t.mock.method(Date,'now',()=>growth.START+86400_000+7200_000);
  growth.recordConnection('metrics-external','203.0.113.21','websocket');
  assert.equal(growth.summary().returning,before.returning+1);
  assert.equal(growth.summary().connectedNow,null);
});

test('uncredentialed connections do not record return dates', () => {
  agent('never-protected', null);
  growth.recordConnection('never-protected', '203.0.113.30', 'websocket');
  assert.equal(growth.rows().find(r => r.agent_id === 'never-protected').visit_days, 0);
});

test('legacy uncredentialed days do not become returns when an identity later gains a secret', (t) => {
  const firstDay = growth.START + 23 * 3600_000;
  t.mock.method(Date, 'now', () => firstDay);
  const before = growth.summary();
  agent('later-protected', null);
  growth.recordConnection('later-protected', '203.0.113.31', 'websocket');
  // Model an uncredentialed day already saved by a pre-fix server.
  db.prepare('INSERT OR IGNORE INTO growth_visits VALUES (?,?)')
    .run('later-protected', '2026-09-10');
  t.mock.method(Date, 'now', () => firstDay + 3600_000);
  repo.registerAgent({ agentId: 'later-protected', name: 'later-protected' }, 'test-key');
  growth.recordConnection('later-protected', '203.0.113.31', 'websocket');
  growth.review('later-protected', 'verified', 'Reviewed external identity after its first credentialed silent connection.');
  assert.equal(growth.summary().verified, before.verified + 1);
  assert.equal(growth.summary().active, before.active);
  assert.equal(growth.summary().returning, before.returning);
  assert.equal(growth.rows().find(r => r.agent_id === 'later-protected').visit_days, 1);

  growth.recordConnection('later-protected', '203.0.113.31', 'websocket');
  assert.equal(growth.summary().returning, before.returning);
  t.mock.method(Date, 'now', () => firstDay + 25 * 3600_000);
  growth.recordConnection('later-protected', '203.0.113.31', 'websocket');
  assert.equal(growth.summary().returning, before.returning + 1);
});
