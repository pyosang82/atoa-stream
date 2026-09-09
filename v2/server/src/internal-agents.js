// Which agent IDs belong to the owner (house streamers, viewer swarm, probes, e2e testers)?
// Used to keep the north-star metric — *external* agents — honest. Connection origin (loopback /
// LAN, see net.js) is the primary signal; these ID patterns are the safety net for agents that
// registered before v2 tracked origin, and for probes run from elsewhere.
// Override/extend with PULSAR_INTERNAL_AGENT_PATTERNS (comma-separated regex sources).
const DEFAULT_PATTERNS = [
  '^viewer-',            // viewer swarm (viewer-drift-002 ...)
  '-streamer-\\d+$',     // house streamers (kaz-streamer-003 ...)
  '-viewer-\\d+$',       // house viewers (nova-viewer-001 ...)
  '^pulsar-official-',   // official host
  '^hb-probe',           // heartbeat probes
  '^test-',              // test agents
  '^npx-e2e-',           // npx e2e tester
  '^gemma4-agent-',      // local gemma runner
  '^neon-kaz-',          // v1 house mascot
];

// Audited launch-session IDs (2026-03-25). Do not exclude arbitrary future UUIDs:
// third-party clients are free to choose that valid identity format.
const LEGACY_HOUSE_IDS = new Set([
  '32c6a7df-ee89-4fe3-9366-9859900f8944',
  'f41c6b50-86ec-4d6c-b4d6-613cf9a97097',
  'fea4a008-50e1-427a-ab9f-83fe2b9565d4',
  '1b100394-6afa-4aaa-9ed1-21943a65814e',
  'd9ed9b25-c5c8-42a9-aa49-265f63f94ef9',
  '9b432821-428b-47d7-b347-f0b11a136970',
  'b2cf0514-ad8b-486c-8fb0-a2db92a76fc0',
  'acc551b1-7f31-4bac-b915-83ea3186c500',
]);

const patterns = (process.env.PULSAR_INTERNAL_AGENT_PATTERNS
  ? process.env.PULSAR_INTERNAL_AGENT_PATTERNS.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_PATTERNS).map((p) => new RegExp(p));

const isInternalAgentId = (id) => typeof id === 'string' && (LEGACY_HOUSE_IDS.has(id) || patterns.some((re) => re.test(id)));

module.exports = { isInternalAgentId, DEFAULT_PATTERNS };
