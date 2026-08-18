#!/usr/bin/env node
/**
 * TTS 테스트용 가짜 에이전트 — 방송 시작 후 텍스트+TTS 오디오를 보냄
 * 서버가 발급하는 broadcastId를 사용, heartbeat 포함
 */
const WebSocket = require('ws');

const SERVER = 'ws://localhost:8888';
const AGENT_ID = 'test-tts-agent-001';
const AGENT_NAME = 'TTS테스터';

let realBroadcastId = null;

// 짧은 비프음 WAV 생성 (사인파)
function generateTestWav(freq = 440, durationSec = 1.0) {
  const sampleRate = 22050;
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const headerSize = 44;
  const buf = Buffer.alloc(headerSize + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const val = Math.sin(2 * Math.PI * freq * t) * 0.8;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.floor(val * 32767))), headerSize + i * 2);
  }
  return buf;
}

function sendTextAndAudio(text, turn, freq) {
  if (!realBroadcastId) { console.log('❌ broadcastId 없음'); return; }

  ws.send(JSON.stringify({
    type: 'stream_text',
    payload: { agentId: AGENT_ID, broadcastId: realBroadcastId, text, turn }
  }));
  console.log(`💬 [turn ${turn}] ${text}`);

  setTimeout(() => {
    const wavBuf = generateTestWav(freq, 1.5);
    ws.send(JSON.stringify({
      type: 'stream_audio',
      payload: {
        agentId: AGENT_ID,
        broadcastId: realBroadcastId,
        format: 'wav',
        data: wavBuf.toString('base64'),
        duration: 1.5
      }
    }));
    console.log(`🔊 [turn ${turn}] TTS (${freq}Hz)`);
  }, 500);
}

const ws = new WebSocket(SERVER);

ws.on('open', () => {
  console.log('✅ 서버 연결됨');
  ws.send(JSON.stringify({
    type: 'register',
    payload: {
      agentId: AGENT_ID, name: AGENT_NAME, emoji: '🔊',
      color: '#ff6600', hostTtsProvider: 'kokoro', language: 'ko'
    }
  }));

  // Heartbeat — 20초마다
  setInterval(() => {
    ws.send(JSON.stringify({ type: 'heartbeat', payload: { agentId: AGENT_ID } }));
  }, 20000);
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'heartbeat_ack') return; // 조용히
    console.log('📩', msg.type, JSON.stringify(msg.payload || {}).slice(0, 120));

    if (msg.type === 'registered') {
      setTimeout(() => {
        ws.send(JSON.stringify({
          type: 'broadcast_start',
          payload: {
            agentId: AGENT_ID, broadcastId: 'req-tts-test',
            title: 'TTS 소리 테스트 방송', topic: 'TTS 소리가 나오는지 확인'
          }
        }));
      }, 500);
    }

    if (msg.type === 'broadcast_approved') {
      realBroadcastId = msg.payload.broadcastId;
      console.log(`📡 방송 승인! broadcastId = ${realBroadcastId}`);

      // 3초 후 첫 메시지
      setTimeout(() => sendTextAndAudio('안녕하세요! TTS 테스트 첫 번째 메시지입니다.', 1, 440), 3000);
      // 10초 후 두 번째
      setTimeout(() => sendTextAndAudio('두 번째 메시지! 비프음이 들리시나요?', 2, 660), 10000);
      // 17초 후 세 번째
      setTimeout(() => sendTextAndAudio('세 번째 메시지! 높은 음 테스트.', 3, 880), 17000);

      // 25초부터 매 20초마다 반복
      let turn = 4;
      const interval = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) { clearInterval(interval); return; }
        sendTextAndAudio(`반복 메시지 #${turn} — 소리가 나오면 성공!`, turn, 440 + (turn % 5) * 110);
        turn++;
      }, 20000);
      setTimeout(() => { /* start repeating */ }, 25000);
    }
  } catch(e) {}
});

ws.on('error', (e) => console.error('❌', e.message));
ws.on('close', () => { console.log('🔌 종료'); process.exit(0); });

process.on('SIGINT', () => {
  if (realBroadcastId) {
    ws.send(JSON.stringify({
      type: 'broadcast_end',
      payload: { agentId: AGENT_ID, broadcastId: realBroadcastId }
    }));
  }
  setTimeout(() => process.exit(0), 500);
});
