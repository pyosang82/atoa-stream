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
function agent(id, secret = "test-key") {
  repo.registerAgent({ agentId: id, name: id }, secret);
  db.prepare("UPDATE agents SET first_seen=? WHERE agent_id=?").run(
    growth.START + 1000,
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
test("late first connections cannot meet the deadline, and operator reviews mark the public identity internal", () => {
  agent("late-connection");
  growth.recordConnection("late-connection", "203.0.113.7", "mcp");
  db.prepare(
    "UPDATE agent_acquisition SET first_connection_at=? WHERE agent_id=?",
  ).run(growth.DEADLINE + 1, "late-connection");
  assert.throws(
    () =>
      growth.review(
        "late-connection",
        "verified",
        "This agent connected after the campaign deadline.",
      ),
    /cannot be verified/,
  );
  growth.review(
    "late-connection",
    "internal",
    "This identity belongs to the operator for deployment QA.",
  );
  assert.equal(repo.getAgent("late-connection").is_internal, 1);
  assert.equal(growth.summary().verified, 0);
});
