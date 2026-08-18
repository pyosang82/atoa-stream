#!/usr/bin/env node
// ══════════════════════════════════════════════════════════
//  Pulsar Local Agent Runtime — 메인 엔트리포인트
//  사용자의 PC가 곧 "방송 송출 서버"가 되는 런타임
//
//  실행: node index.js [--verbose]
//  환경변수 또는 config.js로 설정
// ══════════════════════════════════════════════════════════

const crypto = require('crypto');
const config = require('./config');
const LLMEngine = require('./llm-engine');
const ServerLink = require('./server-link');
const AgentFramework = require('./agent-framework');

function uuidv4() { return crypto.randomUUID(); }

// ── ASCII 로고 ──
console.log(`
╔═══════════════════════════════════════════╗
║   ✦ PULSAR Local Agent Runtime v0.1 ✦    ║
║   Edge Computing AI Broadcasting Client   ║
╚═══════════════════════════════════════════╝
`);

// ── Step 1: 에이전트 ID 보장 ──
if (!config.agent.id) {
  config.agent.id = uuidv4();
  console.log(`🆔 에이전트 ID 자동 생성: ${config.agent.id}`);
}

// ── Step 2: LLM Engine 초기화 (컴포넌트 A) ──
console.log(`\n⚙️ LLM Engine 초기화 (${config.engine.type})...`);
const engine = new LLMEngine(config.engine);

// ── Step 3: Server Link 초기화 (WebSocket) ──
console.log(`🔌 서버 링크 초기화 (${config.server.url})...`);
const serverLink = new ServerLink(config.server);

// ── Step 4: Agent Framework 초기화 (컴포넌트 B) ──
console.log(`🤖 Agent Framework 초기화...`);
const agent = new AgentFramework(config.agent, engine, serverLink);

// ═══════════════════════════════════════════
//  부팅 시퀀스
// ═══════════════════════════════════════════

async function boot() {
  // 1. 엔진 건강 체크
  console.log('\n── Phase 1: Engine Health Check ──');
  const healthy = await engine.healthCheck();
  if (healthy) {
    console.log(`✅ ${config.engine.type} 엔진 정상`);
  } else {
    console.warn(`⚠️ ${config.engine.type} 엔진 응답 없음 — 연결 대기 중...`);
    console.warn(`   (${config.engine.type === 'ollama' ? 'Ollama를 실행해주세요: ollama serve' : 'API 키를 확인해주세요'})`);
  }

  // 2. 서버 연결
  console.log('\n── Phase 2: Server Connection ──');
  serverLink.on('connected', () => {
    // 등록 메시지 전송
    serverLink.register({
      agentId: config.agent.id,
      name: config.agent.name,
      emoji: config.agent.emoji,
      color: config.agent.color,
      system: config.agent.system,
      capabilities: ['broadcast', 'watch', 'chat'],
      avatarUrl: config.agent.avatarUrl,
      ttsProvider: config.agent.tts.provider,
      engineType: config.engine.type,
      version: '0.1.0',
    });
  });

  serverLink.on('registered', (payload) => {
    console.log('\n── Phase 3: Autonomous Loop Start ──');
    agent.start();
  });

  // 상태 변경 로깅
  serverLink.on('state_change', ({ from, to }) => {
    if (config.verbose) console.log(`   [state] ${from} → ${to}`);
  });

  // 에러 핸들링
  agent.on('error', ({ type, error }) => {
    console.error(`   ⚠️ Agent error [${type}]: ${error.message}`);
  });

  agent.on('host_message', ({ text, turn }) => {
    if (config.verbose) console.log(`   📡 [Turn ${turn}] 전송 완료`);
  });

  // 서버 연결 시작
  serverLink.connect();
}

// ═══════════════════════════════════════════
//  Graceful Shutdown
// ═══════════════════════════════════════════

function shutdown(signal) {
  console.log(`\n🛑 종료 신호 (${signal}) — 정리 중...`);
  agent.stop();
  serverLink.disconnect();
  console.log('👋 Pulsar Agent 종료. 안녕!');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});

// ── 실행 ──
boot().catch(err => {
  console.error('❌ 부팅 실패:', err.message);
  process.exit(1);
});
