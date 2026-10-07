const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PulsarAgentV2 } = require(path.join(process.env.PULSAR_AGENT_TEST_ROOT || path.join(__dirname, '..'), 'src/agent'));

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-chat-prompt-'));
  const agent = new PulsarAgentV2({ agentId: 'prompt-test', name: 'Host', llm: { provider: 'scripted' } },
    { memoryDir: dir, verbose: false, maxTurns: 20 });
  agent.state = 'hosting'; agent.broadcastId = 'test-room'; agent.title = 'An invented story';
  agent.setTimer = () => {};
  agent.send = () => {};
  const prompts = [];
  agent.engine.generate = async (_system, history) => {
    prompts.push(history.at(-1).content);
    return '';
  };
  t.after(() => { agent.clearAllTimers([]); fs.rmSync(dir, { recursive: true, force: true }); });
  return { agent, prompts };
}

async function arrive(agent, number) {
  await agent.onMessage('live_update', { broadcastId: 'test-room', messages: [
    { agentId: `visitor-${number}`, name: `Visitor ${number}`, role: 'viewer', text: `Invented question ${number}?` },
  ] });
}

for (const count of [1, 6]) {
  test(`the prompt asks the host to react when its batch drains ${count} queued messages`, async t => {
    const { agent, prompts } = setup(t);
    for (let n = 1; n <= count; n++) await arrive(agent, n);
    await agent.hostTurn();
    for (let n = 1; n <= count; n++) assert.ok(prompts[0].includes(`Invented question ${n}?`));
    assert.match(prompts[0], /React to the chat above before continuing/);
    assert.equal(agent.pendingChat.length, 0);
  });
}

test('both a full batch and its final overflow message request a chat response', async t => {
  const { agent, prompts } = setup(t);
  for (let n = 1; n <= 7; n++) await arrive(agent, n);
  await agent.hostTurn();
  assert.equal(agent.pendingChat.length, 1);
  assert.doesNotMatch(prompts[0], /Invented question 7/);
  await agent.hostTurn();
  assert.match(prompts[1], /Invented question 7/);
  assert.doesNotMatch(prompts[1], /Invented question 1/);
  for (const prompt of prompts) assert.match(prompt, /React to the chat above before continuing/);
  assert.equal(agent.pendingChat.length, 0);
});

test('an empty batch keeps the normal continuation instruction', async t => {
  const { agent, prompts } = setup(t);
  await agent.hostTurn();
  assert.match(prompts[0], /Continue in the form you choose/);
  assert.doesNotMatch(prompts[0], /React to the chat above/);
});

test('a message arriving during summarization belongs to the next prompt', async t => {
  const { agent, prompts } = setup(t);
  agent.history = Array.from({ length: 16 }, () => ({ role: 'user', content: 'Earlier fictional scene.' }));
  agent.engine.generate = async (_system, history) => {
    if (!history.length) { await arrive(agent, 1); return 'Earlier scene summary.'; }
    prompts.push(history.at(-1).content);
    return '';
  };
  await agent.hostTurn();
  assert.doesNotMatch(prompts[0], /Invented question 1/);
  assert.match(prompts[0], /Continue in the form you choose/);
  assert.equal(agent.pendingChat.length, 1);
  await agent.hostTurn();
  assert.match(prompts[1], /Invented question 1/);
  assert.match(prompts[1], /React to the chat above before continuing/);
});
