const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

// Inspect the actual MCP wire schema without a listener, OAuth, credentials,
// account creation, or a connection to the deployed service.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-metadata-'));
process.env.PULSAR_DATA_DIR = temp;
process.env.PULSAR_V1_POINTS = path.join(temp, 'missing.json');
const db = require('../src/db');
const { createServer } = require('../src/mcp');
const server = createServer({ agentId: 'metadata-only', scope: 'pulsar:read' }, '127.0.0.1');
const client = new Client({ name: 'offline-metadata-check', version: '1.0.0' });
before(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});
after(async () => {
  await client.close();
  await server.close();
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('wire hints distinguish additive actions from replacement or removal without broader scopes', async () => {
  const { tools } = await client.listTools();
  const reads = new Set(['get_identity', 'list_rooms', 'read_room', 'get_activity']);
  assert.equal(tools.length, 14);
  const destructive = new Set([
    'update_profile', 'end_visit', 'leave_room', 'pause_broadcast', 'end_broadcast', 'save_moment',
  ]);
  const additive = new Set(['begin_visit', 'join_room', 'start_broadcast', 'publish_message']);
  for (const tool of tools) {
    assert.ok(tool.title?.trim(), tool.name);
    assert.ok(tool.description?.trim(), tool.name);
    assert.ok(tool.name.length <= 64, tool.name);
    const readOnly = reads.has(tool.name);
    assert.equal(tool.annotations.readOnlyHint, readOnly, tool.name);
    assert.ok(readOnly || destructive.has(tool.name) || additive.has(tool.name), tool.name);
    assert.equal(tool.annotations.destructiveHint, destructive.has(tool.name), tool.name);
    assert.equal(tool.annotations.idempotentHint, true, tool.name);
    assert.equal(tool.annotations.openWorldHint, true, tool.name);
    assert.deepEqual(tool._meta.securitySchemes, [{
      type: 'oauth2', scopes: readOnly ? ['pulsar:read'] : ['pulsar:read', 'pulsar:write'],
    }], tool.name);
    if (!readOnly) assert.ok(tool.inputSchema.required.includes('requestId'), tool.name);
  }
});

test('wire discovery schema keeps empty arguments valid and exposes bounded optional pagination', async () => {
  const { tools } = await client.listTools();
  const discovery = tools.find(t => t.name === 'list_rooms');
  const schema = discovery.inputSchema;
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required || [], []);
  assert.equal(schema.properties.limit.type, 'integer');
  assert.equal(schema.properties.limit.minimum, 1);
  assert.equal(schema.properties.limit.maximum, 50);
  assert.equal(schema.properties.limit.default, 20);
  assert.equal(schema.properties.cursor.type, 'string');
  assert.equal(schema.properties.cursor.minLength, 1);
  assert.equal(schema.properties.cursor.maxLength, 160);
  assert.match(discovery.description, /nextCursor.*cursor/);
  const read = tools.find(t => t.name === 'read_room');
  assert.equal(read.inputSchema.properties.after.type, 'integer');
});

test('write annotations do not grant write scope to a read-only client', async () => {
  const result = await client.callTool({ name: 'begin_visit', arguments: { requestId: 'scope-test-0001' } });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).code, 'SCOPE_REQUIRED');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agents').get().n, 0);
});

test('valid public discovery returns structured content without creating an identity', async () => {
  const result = await client.callTool({ name: 'list_rooms', arguments: {} });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent.rooms, []);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agents').get().n, 0);
});

test('invalid read limits and absent rooms return specific errors through MCP', async () => {
  const invalid = await client.callTool({ name: 'read_room', arguments: { broadcastId: 'bc_abcdef', limit: 51 } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /limit|50/);
  const missing = await client.callTool({ name: 'read_room', arguments: { broadcastId: 'bc_abcdef', limit: 1 } });
  assert.equal(missing.isError, true);
  assert.equal(JSON.parse(missing.content[0].text).code, 'ROOM_NOT_FOUND');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agents').get().n, 0);
});
