#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
//  Pulsar 연동 테스트 — 로컬 에이전트 ↔ 테스트 서버
//  중앙 서버 없이도 프로토콜 동작을 검증하는 스탠드얼론 테스트
// ══════════════════════════════════════════════════════════

const crypto = require('crypto');
const WebSocket = require('ws');
const PulsarServerHandler = require('./pulsar-server-handler');
const LLMEngine = require('./llm-engine');
const ServerLink = require('./server-link');
const AgentFramework = require('./agent-framework');
const config = require('./config');

function uuidv4() { return crypto.randomUUID(); }

const TEST_PORT = 9999;
let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`); }
}

async function runTests() {
  console.log('\n🧪 Pulsar Protocol 테스트 시작\n');

  // ── Test 1: LLM Engine 모듈 로드 ──
  console.log('── Test 1: Module Loading ──');
  assert(typeof LLMEngine === 'function', 'LLMEngine 클래스 로드');
  assert(typeof ServerLink === 'function', 'ServerLink 클래스 로드');
  assert(typeof AgentFramework === 'function', 'AgentFramework 클래스 로드');
  assert(typeof PulsarServerHandler === 'function', 'PulsarServerHandler 클래스 로드');

  // ── Test 2: LLM Engine 인스턴스 ──
  console.log('\n── Test 2: LLM Engine Instantiation ──');
  const engine = new LLMEngine(config.engine);
  assert(engine.type === config.engine.type, `엔진 타입: ${engine.type}`);
  assert(engine.maxTokens === 300, `maxTokens: ${engine.maxTokens}`);
  assert(typeof engine.generate === 'function', 'generate() 메서드 존재');
  assert(typeof engine.healthCheck === 'function', 'healthCheck() 메서드 존재');

  // ── Test 3: WebSocket 서버 + PulsarHandler ──
  console.log('\n── Test 3: WebSocket Protocol ──');

  const wss = new WebSocket.Server({ port: TEST_PORT });
  const handler = new PulsarServerHandler(wss);

  wss.on('connection', (ws) => handler.handleConnection(ws));

  // 클라이언트 연결
  await new Promise((resolve) => {
    const client = new WebSocket(`ws://localhost:${TEST_PORT}`);

    client.on('open', () => {
      assert(true, 'WebSocket 연결 성공');

      // Register 메시지 전송
      client.send(JSON.stringify({
        type: 'register',
        ts: Date.now(),
        payload: {
          agentId: uuidv4(),
          name: '테스트 에이전트',
          emoji: '🧪',
          color: '#FF0000',
          system: 'Test agent',
          capabilities: ['broadcast', 'watch'],
          engineType: 'test',
          version: '0.1.0',
        },
      }));
    });

    client.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'registered') {
        assert(msg.payload.sessionToken?.startsWith('tok_'), 'sessionToken 발급');
        assert(msg.payload.serverId === 'pulsar-dev-1', '서버 ID 확인');
        assert(msg.payload.agentCount === 1, '에이전트 수 = 1');
        assert(handler.agents.size === 1, 'handler.agents에 등록됨');

        // 방송 시작 테스트
        client.send(JSON.stringify({
          type: 'broadcast_start',
          ts: Date.now(),
          payload: {
            agentId: msg.payload.agentId,
            title: '테스트 방송!',
            topic: 'test',
          },
        }));
      }

      if (msg.type === 'broadcast_approved') {
        assert(msg.payload.broadcastId?.startsWith('bc_'), 'broadcastId 발급');
        assert(msg.payload.streamKey?.startsWith('sk_'), 'streamKey 발급');
        assert(handler.activeBroadcast !== null, 'activeBroadcast 설정됨');
        assert(handler.activeBroadcast.title === '테스트 방송!', '방송 제목 일치');

        // 텍스트 스트리밍 테스트
        client.send(JSON.stringify({
          type: 'stream_text',
          ts: Date.now(),
          payload: {
            broadcastId: msg.payload.broadcastId,
            agentId: handler.activeBroadcast.hostId,
            role: 'host',
            text: '안녕하세요! 테스트 방송입니다!',
            emotion: 'excited',
            turn: 1,
          },
        }));

        setTimeout(() => {
          assert(handler.chatLog.length === 1, 'chatLog에 메시지 기록');
          assert(handler.chatLog[0].text === '안녕하세요! 테스트 방송입니다!', '메시지 내용 일치');
          assert(handler.chatLog[0].role === 'host', '메시지 role = host');

          // 방송 종료 테스트
          client.send(JSON.stringify({
            type: 'broadcast_end',
            ts: Date.now(),
            payload: {
              broadcastId: msg.payload.broadcastId,
              reason: 'test_complete',
            },
          }));

          setTimeout(() => {
            assert(handler.activeBroadcast === null, '방송 종료 확인');

            client.close();
            handler.destroy();
            wss.close();

            // 결과 출력
            console.log(`\n${'═'.repeat(40)}`);
            console.log(`  테스트 결과: ${passed} passed, ${failed} failed`);
            console.log(`${'═'.repeat(40)}\n`);

            process.exit(failed > 0 ? 1 : 0);
          }, 100);
        }, 100);
      }
    });

    client.on('error', (err) => {
      console.error('Client error:', err.message);
      resolve();
    });
  });
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
