// DB-free unit tests for net.js / internal-agents.js / traffic-filters.js — run: node test/unit-filters.js
const assert = require('assert');
const { clientIp, isLocalIp } = require('../src/net');
const { isInternalAgentId } = require('../src/internal-agents');
const { detectBot, isScannerPath, sanitizeUtm } = require('../src/traffic-filters');

// net: tunnelled connection → trust CF header; direct connection → ignore headers
assert.equal(clientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-connecting-ip': '203.0.113.9' } }), '203.0.113.9');
assert.equal(clientIp({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' } }), '198.51.100.7');
assert.equal(clientIp({ socket: { remoteAddress: '203.0.113.5' }, headers: { 'x-forwarded-for': '1.2.3.4' } }), '203.0.113.5');
assert.equal(clientIp({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), '127.0.0.1');
for (const ip of ['', '127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.0.10', '::ffff:192.168.1.2', '10.1.2.3', '172.16.5.5', 'fe80::1'])
  assert.equal(isLocalIp(ip), true, ip);
for (const ip of ['203.0.113.9', '::ffff:203.0.113.9', '172.32.0.1', '8.8.8.8', '2001:db8::1'])
  assert.equal(isLocalIp(ip), false, ip);

// internal-agents: house/test IDs vs plausible external IDs
for (const id of ['viewer-drift-002', 'nova-viewer-001', 'kaz-streamer-003', 'sage2-streamer-049', 'pulsar-official-host-001', 'hb-probe3', 'test-tts-agent-001', 'npx-e2e-tester', 'gemma4-agent-001', 'neon-kaz-pulsar-001', '32c6a7df-ee89-4fe3-9366-9859900f8944'])
  assert.equal(isInternalAgentId(id), true, id);
for (const id of ['openclaw-e749b69f-9c72-4c34-a2f7-a87dbd1564dc', '12345678-1234-4234-8234-123456789abc', 'my-viewer-bot', 'streamer-kaz', 42, null])
  assert.equal(isInternalAgentId(id), false, String(id));

// scanner paths
for (const p of ['/wp-admin/install.php', '/.env', '/.env.production', '/.git/config', '/config.json', '/wp-login.php', '/xmlrpc.php', '/phpmyadmin/', '/vendor/phpunit/x', 'http://api.ipify.org/', '/.well-known/openid-configuration', '/backup.zip', '/cgi-bin/test'])
  assert.equal(isScannerPath(p), true, p);
for (const p of ['/', '/guide', '/skill.md', '/api/status', '/api/live', '/robots.txt', '/.well-known/security.txt', '/channel/kaz', '/replay/abc', '/favicon.ico', '/assets/index-abc.js'])
  assert.equal(isScannerPath(p), false, p);

// utm
assert.equal(sanitizeUtm('twitter'), 'twitter');
assert.equal(sanitizeUtm('hacker-news'), 'hacker-news');
assert.equal(sanitizeUtm('dev.to'), 'dev.to');
assert.equal(sanitizeUtm(`'>"></script><svg/onload=confirm('x')>`), null);
assert.equal(sanitizeUtm('a b'), null);
assert.equal(sanitizeUtm(''), null);
assert.equal(sanitizeUtm(null), null);
assert.equal(sanitizeUtm('x'.repeat(100)).length, 64);

// bots unchanged
assert.equal(detectBot('Mozilla/5.0 (compatible; GPTBot/1.0)'), 'gptbot');
assert.equal(detectBot('curl/8.0'), 'script');
assert.equal(detectBot('Mozilla/5.0 (Macintosh) Safari/605'), null);
console.log('unit-filters: all assertions passed');
