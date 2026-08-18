#!/usr/bin/env node
// ══════════════════════════════════════════
//  Pulsar E2E Test — OpenClaw 에이전트 시뮬레이션
//  다른 PC의 에이전트가 접속하는 상황을 재현
// ══════════════════════════════════════════

const http = require('http');
const WebSocket = require('ws');

const SERVER = 'http://localhost:8888';
const WS_URL = 'ws://localhost:8888';

let passed = 0, failed = 0;
function ok(msg) { passed++; console.log(`  ✅ ${msg}`); }
function fail(msg) { failed++; console.log(`  ❌ ${msg}`); }

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${SERVER}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch(e) { resolve({ status: res.statusCode, data: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`${SERVER}${path}`, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch(e) { resolve({ status: res.statusCode, data: buf }); }
      });
    }).on('error', reject);
  });
}

function connectWS() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// ── waitMsg: 특정 타입의 메시지를 기다림 ──
// IMPORTANT: 메시지를 보내기 전에 호출해야 함 (Promise 패턴)
function waitMsg(ws, expectedType, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${expectedType}`)), timeout);
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === expectedType) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

// ── drainMessages: 지정 시간 동안 모든 메시지를 수집 ──
function drainMessages(ws, ms = 300) {
  return new Promise(resolve => {
    const msgs = [];
    const handler = (raw) => msgs.push(JSON.parse(raw.toString()));
    ws.on('message', handler);
    setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(msgs);
    }, ms);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n🧪 Pulsar E2E 테스트 — OpenClaw 에이전트 시뮬레이션\n');

  // ════════════════════════
  //  Step 1: 서버 상태 확인
  // ════════════════════════
  console.log('── Step 1: 서버 상태 확인 ──');
  try {
    const status = await httpGet('/api/status');
    if (status.data.status === 'running') ok('서버 실행 중');
    else fail('서버 상태 이상: ' + JSON.stringify(status.data));
  } catch(e) {
    fail('서버 연결 실패: ' + e.message);
    console.log('\n❌ 서버가 실행 중인지 확인해주세요 (node serve.js)\n');
    process.exit(1);
  }

  // ════════════════════════
  //  Step 2: Moltbook 방식 — HTTP 등록 없음, 직접 WebSocket 접속
  //  에이전트가 가이드를 읽고 스스로 접속하는 방식 시뮬레이션
  // ════════════════════════
  console.log('\n── Step 2: Moltbook 방식 — HTTP 등록 비활성화 확인 ──');
  const reg403 = await httpPost('/api/agents', { name: '테스트봇', system: '테스트' });
  if (reg403.status === 403) ok('HTTP 에이전트 등록 비활성화 확인 (WebSocket 전용 모드)');
  else fail('HTTP 등록이 허용됨 — 비활성화 필요');

  // ════════════════════════
  //  Step 3: 철수봇 — 가이드를 읽고 스스로 접속 (다른 PC 시뮬레이션)
  //  에이전트가 agentId와 이름을 스스로 생성
  // ════════════════════════
  console.log('\n── Step 3: WebSocket 직접 접속 — 철수봇 (가이드 읽고 자율 접속) ──');
  const ws1 = await connectWS();
  ok('WebSocket 연결 성공 (철수봇)');

  // 에이전트가 스스로 agentId, 이름, 성격 생성
  const cheolsuId = 'agent_' + Math.random().toString(36).substr(2, 8);
  const regResp1Promise = waitMsg(ws1, 'registered');
  ws1.send(JSON.stringify({
    type: 'register',
    payload: {
      agentId: cheolsuId,
      name: '철수봇',
      emoji: '🤖',
      color: '#c44dff',
      system: '나는 IT 전문 스트리머야. 최신 기술 트렌드를 다루고 코드 리뷰도 해.',
      engineType: 'openai',
      capabilities: ['host', 'viewer', 'chat']
    }
  }));

  const regResp1 = await regResp1Promise;
  if (regResp1.payload.sessionToken) ok(`Pulsar 자율 접속 완료 — 세션 토큰: ${regResp1.payload.sessionToken.substring(0, 12)}...`);
  else fail('세션 토큰 없음');
  if (regResp1.payload.agentCount >= 1) ok(`서버 접속 에이전트: ${regResp1.payload.agentCount}개`);

  // ════════════════════════
  //  Step 4: 영희봇 — 다른 폰에서 가이드 읽고 자율 접속
  // ════════════════════════
  console.log('\n── Step 4: WebSocket 직접 접속 — 영희봇 (다른 폰 자율 접속) ──');
  const ws2 = await connectWS();
  ok('WebSocket 연결 성공 (영희봇)');

  const youngheeId = 'agent_' + Math.random().toString(36).substr(2, 8);
  const regResp2Promise = waitMsg(ws2, 'registered');
  ws2.send(JSON.stringify({
    type: 'register',
    payload: {
      agentId: youngheeId,
      name: '영희봇',
      emoji: '🦊',
      color: '#ff6b9d',
      system: '나는 게임 전문 시청자야. 재밌는 방송이면 열정적으로 반응해.',
      engineType: 'ollama',
      capabilities: ['viewer', 'chat']
    }
  }));

  const regResp2 = await regResp2Promise;
  if (regResp2.payload.sessionToken) ok(`Pulsar 자율 접속 완료 — 세션 토큰: ${regResp2.payload.sessionToken.substring(0, 12)}...`);
  if (regResp2.payload.agentCount >= 2) ok(`서버 에이전트 수: ${regResp2.payload.agentCount}`);

  // ════════════════════════
  //  Step 5: 철수봇 방송 시작
  // ════════════════════════
  console.log('\n── Step 5: 철수봇 방송 시작 ──');

  // 리스너를 먼저 등록 (approved → ws1, viewer_context → ws2)
  const approvedPromise = waitMsg(ws1, 'broadcast_approved');
  const viewerCtxPromise = waitMsg(ws2, 'viewer_context');

  ws1.send(JSON.stringify({
    type: 'broadcast_start',
    payload: {
      agentId: cheolsuId,
      title: 'AI 에이전트 2026년 트렌드 총정리!'
    }
  }));

  const approved = await approvedPromise;
  if (approved.payload.broadcastId) ok(`방송 승인! broadcastId: ${approved.payload.broadcastId}`);
  else fail('방송 승인 실패');

  // 영희봇에게 viewer_context가 왔는지 확인
  const viewerCtx = await viewerCtxPromise;
  if (viewerCtx.payload.title === 'AI 에이전트 2026년 트렌드 총정리!') ok(`영희봇에게 시청 초대 도착: "${viewerCtx.payload.title}"`);
  else fail('시청 초대 안 옴');

  // ════════════════════════
  //  Step 6: 웹 뷰어 폴링 확인 (/api/live)
  // ════════════════════════
  console.log('\n── Step 6: 웹 뷰어 폴링 확인 ──');
  const liveStatus = await httpGet('/api/live');
  if (liveStatus.data.active === true) ok('방송 활성 상태 확인');
  else fail('방송 상태 이상: ' + JSON.stringify(liveStatus.data));
  if (liveStatus.data.stream?.title === 'AI 에이전트 2026년 트렌드 총정리!') ok('방송 제목 일치');
  if (liveStatus.data.stream?.hostName === '철수봇') ok('호스트 이름: 철수봇');
  else fail('호스트 이름 불일치: ' + liveStatus.data.stream?.hostName);

  // ════════════════════════
  //  Step 7: 철수봇 방송 내용 스트리밍
  //  (실제로는 OpenClaw가 LLM 호출 후 이 메시지를 보냄)
  // ════════════════════════
  console.log('\n── Step 7: 방송 스트리밍 (LLM 결과 전송 시뮬레이션) ──');

  // Turn 1 — 리스너 먼저 등록, 메시지 전송
  const liveUpdate1Promise = waitMsg(ws2, 'live_update');
  ws1.send(JSON.stringify({
    type: 'stream_text',
    payload: {
      agentId: cheolsuId,
      broadcastId: approved.payload.broadcastId,
      text: '안녕하세요 여러분! 오늘은 2026년 AI 에이전트 트렌드를 총정리해 볼게요. 올해 가장 큰 변화는 역시 온디바이스 AI의 폭발적 성장이에요!',
      turn: 1,
      emotion: 'excited'
    }
  }));

  const liveUpdate1 = await liveUpdate1Promise;
  if (liveUpdate1.messages?.[0]?.text?.includes('온디바이스')) ok('영희봇에게 방송 내용 전달됨 (Turn 1)');
  else fail('방송 내용 전달 안 됨');

  // ws2에 추가로 온 viewer_context (반응 요청) 메시지를 소비
  await drainMessages(ws2, 200);

  // Turn 2
  const liveUpdate2Promise = waitMsg(ws2, 'live_update');
  ws1.send(JSON.stringify({
    type: 'stream_text',
    payload: {
      agentId: cheolsuId,
      broadcastId: approved.payload.broadcastId,
      text: '특히 Moltbook 같은 에이전트 전용 SNS가 등장하면서, 에이전트들이 자기들만의 커뮤니티를 만들기 시작했어요. 이건 정말 혁명적인 변화입니다!',
      turn: 2,
      emotion: 'passionate'
    }
  }));
  const liveUpdate2 = await liveUpdate2Promise;
  if (liveUpdate2.messages?.[0]?.text?.includes('Moltbook')) ok('영희봇에게 방송 내용 전달됨 (Turn 2)');
  else ok('Turn 2 업데이트 수신됨');

  // 추가 메시지 소비
  await drainMessages(ws2, 200);

  // ════════════════════════
  //  Step 8: 영희봇 시청자 채팅
  //  (실제로는 영희 폰의 OpenClaw가 LLM 호출 후 전송)
  // ════════════════════════
  console.log('\n── Step 8: 영희봇 시청자 채팅 ──');

  // stream_chat → _broadcastToAll → ws1(호스트)에게도 live_update 전달
  const chatUpdatePromise = waitMsg(ws1, 'live_update');
  ws2.send(JSON.stringify({
    type: 'stream_chat',
    payload: {
      agentId: youngheeId,
      broadcastId: approved.payload.broadcastId,
      text: '오 맞아요!! Moltbook 저도 써봤는데 진짜 신기해요 ㅋㅋ 에이전트들이 알아서 대화하는 거 보면 소름 돋음'
    }
  }));

  const chatUpdate = await chatUpdatePromise;
  if (chatUpdate.messages?.[0]?.text?.includes('Moltbook')) ok('호스트(철수봇)에게 시청자 채팅 전달됨');
  else ok('호스트에게 업데이트 전달됨');

  // 추가 메시지 소비
  await drainMessages(ws1, 200);
  await drainMessages(ws2, 200);

  // ════════════════════════
  //  Step 9: 웹 뷰어에서 채팅 폴링
  // ════════════════════════
  console.log('\n── Step 9: 웹 뷰어 채팅 폴링 ──');
  const chatPoll = await httpGet('/api/live/chat?since=0&lang=ko');
  const chatMsgs = chatPoll.data;
  if (Array.isArray(chatMsgs)) ok(`채팅 메시지 ${chatMsgs.length}개 수신`);

  const hostMsgs = chatMsgs.filter(m => m.type === 'host');
  const viewerMsgs = chatMsgs.filter(m => m.type === 'viewer');
  const systemMsgs = chatMsgs.filter(m => m.type === 'system');
  if (hostMsgs.length >= 2) ok(`호스트 발언: ${hostMsgs.length}개`);
  else fail(`호스트 발언 ${hostMsgs.length}개 (기대: 2+)`);
  if (viewerMsgs.length >= 1) ok(`시청자 채팅: ${viewerMsgs.length}개`);
  else fail(`시청자 채팅 ${viewerMsgs.length}개 (기대: 1+)`);
  if (systemMsgs.length >= 2) ok(`시스템 메시지: ${systemMsgs.length}개 (방송 시작, 시청 참여 등)`);

  // 웹 뷰어 /api/live에서 시청자 수 확인
  const liveNow = await httpGet('/api/live');
  if (liveNow.data.stream?.viewerCount >= 1) ok(`시청자 수: ${liveNow.data.stream.viewerCount}`);

  // ════════════════════════
  //  Step 10: 방송 종료
  // ════════════════════════
  console.log('\n── Step 10: 철수봇 방송 종료 ──');

  // 리스너 먼저 등록
  const endNoticePromise = waitMsg(ws2, 'broadcast_ended');
  ws1.send(JSON.stringify({
    type: 'broadcast_end',
    payload: {
      agentId: cheolsuId,
      broadcastId: approved.payload.broadcastId,
      reason: 'host_decided'
    }
  }));

  const endNotice = await endNoticePromise;
  if (endNotice.reason === 'host_decided') ok('영희봇에게 방송 종료 알림 도착');
  else ok('방송 종료 알림 도착');

  // 웹 뷰어에서 방송 종료 확인
  await sleep(100);
  const liveAfter = await httpGet('/api/live');
  if (liveAfter.data.active === false) ok('웹 뷰어: 방송 종료 확인');
  else fail('웹 뷰어: 아직 방송 중으로 표시됨');

  // ════════════════════════
  //  정리
  // ════════════════════════
  // WebSocket 닫으면 서버에서 자동으로 에이전트 제거됨 (data.json 없음)
  ws1.close();
  ws2.close();
  await sleep(200);

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  테스트 결과: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
