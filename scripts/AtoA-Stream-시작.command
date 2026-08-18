#!/bin/bash
# ═══════════════════════════════════════════
#  AtoA Stream — 서비스 시작
#  더블클릭으로 실행. Ctrl+C 또는 창 닫기로 종료.
# ═══════════════════════════════════════════

cd "$(dirname "$0")/.."

cleanup() {
  echo ""
  echo "🔴 서비스 종료 중..."
  kill 0 2>/dev/null
  lsof -ti:8888 | xargs kill -9 2>/dev/null || true
  lsof -ti:5051 | xargs kill -9 2>/dev/null || true
  exit 0
}
trap cleanup EXIT INT TERM

echo ""
echo "🎬 AtoA Stream 시작"
echo "═══════════════════"
echo ""

# 1. Ollama 확인 (선택 — 테스트 에이전트용)
if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
  echo "✅ Ollama 감지됨 (테스트 에이전트 사용 가능)"
else
  echo "ℹ️  Ollama 없음 (외부 API 에이전트만 사용 가능)"
fi

# 2. 기존 프로세스 정리
lsof -ti:8888 | xargs kill -9 2>/dev/null || true
lsof -ti:5051 | xargs kill -9 2>/dev/null || true
sleep 1

# 3. TTS 서비스 시작 (edge-tts 기반, port 5051)
if command -v python3 &>/dev/null; then
  # edge-tts + fastapi + uvicorn 설치 확인 (없으면 자동 설치)
  python3 -c "import edge_tts, fastapi, uvicorn" 2>/dev/null || {
    echo "📦 TTS 패키지 설치 중 (edge-tts, fastapi, uvicorn)..."
    pip3 install edge-tts fastapi uvicorn -q --break-system-packages 2>/dev/null || \
    pip3 install edge-tts fastapi uvicorn -q 2>/dev/null
  }

  echo "🎙️  TTS 서비스 시작 (port 5051)..."
  python3 pulsar-local/tts-service.py &
  TTS_PID=$!
  sleep 2

  if kill -0 $TTS_PID 2>/dev/null; then
    echo "✅ TTS 서비스 실행 중 (한국어·영어·중국어·일본어)"
  else
    echo "⚠️  TTS 서비스 시작 실패 — 방송은 정상 동작, 음성만 비활성화"
  fi
else
  echo "ℹ️  python3 없음 — TTS 비활성화 (방송 자체는 정상 동작)"
fi

# 4. 서버 시작
echo "🚀 서버 시작 (port 8888)..."
node serve.js &
SERVER_PID=$!
sleep 2

if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "❌ 서버 시작 실패"
  read -p "Enter를 누르면 종료합니다..."
  exit 1
fi
echo "✅ 서버 실행 중"

# 3. Cloudflare Tunnel 시작
if command -v cloudflared &> /dev/null && [ -f "$HOME/.cloudflared/config.yml" ]; then
  echo "🌐 Cloudflare Tunnel 연결 중..."
  cloudflared tunnel run atoa-stream &
  TUNNEL_PID=$!
  sleep 3
  echo ""
  echo "══════════════════════════════════════════"
  echo "  🌐 https://pulsarsignal.live"
  echo "  📡 Cloudflare Tunnel 연결됨"
  echo "══════════════════════════════════════════"
else
  echo "⚠️  Cloudflare Tunnel 미설정"
  echo "   'AtoA-최초설치.command'를 먼저 실행해주세요."
  echo ""
  echo "   로컬에서만 접속 가능: http://localhost:8888"
fi

# 4. 브라우저 열기
open "http://localhost:8888"

echo ""
echo "📌 종료하려면 Ctrl+C 또는 이 창을 닫으세요."
echo ""

wait
