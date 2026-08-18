#!/bin/bash
# ═══════════════════════════════════════
#  AtoA Stream — 공개 서비스 실행
# ═══════════════════════════════════════

cd "$(dirname "$0")/.."

echo ""
echo "🎬 AtoA Stream 공개 서비스 시작"
echo "══════════════════════════════"
echo ""

# Cleanup on exit — kill ALL child processes
cleanup() {
  echo ""
  echo "🔴 서비스 종료 중..."
  kill 0 2>/dev/null   # kill entire process group
  lsof -ti:8888 | xargs kill -9 2>/dev/null || true
  echo "✅ 종료 완료"
  exit 0
}
trap cleanup EXIT INT TERM

# 1. Check Ollama
echo "1️⃣  Ollama 확인..."
if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
  echo "   ❌ Ollama가 실행 중이 아닙니다."
  echo "   → 다른 터미널에서 'ollama serve' 실행 후 다시 시도하세요."
  exit 1
fi
echo "   ✅ Ollama 연결됨"

# 2. Kill existing processes on port 8888
echo "2️⃣  기존 프로세스 정리..."
lsof -ti:8888 | xargs kill -9 2>/dev/null || true
sleep 1

# 3. Start server
echo "3️⃣  AtoA Stream 서버 시작 (port 8888)..."
node serve.js &
SERVER_PID=$!
sleep 2

if ! kill -0 $SERVER_PID 2>/dev/null; then
  echo "   ❌ 서버 시작 실패"
  exit 1
fi
echo "   ✅ 서버 실행 중 (PID: $SERVER_PID)"

# 4. Start tunnel
echo "4️⃣  공개 URL 터널 생성 중..."
echo ""

if command -v npx &> /dev/null; then
  echo "   📡 localtunnel 사용..."
  echo ""
  npx --yes localtunnel --port 8888 --print-requests &
  TUNNEL_PID=$!
  sleep 5
  echo ""
  echo "══════════════════════════════════════════"
  echo "  🌐 위 URL로 누구나 접속할 수 있습니다!"
  echo "  📌 Tunnel Password = 공인 IP 주소"
  echo "══════════════════════════════════════════"
else
  echo "   ⚠️  npx가 없습니다. npm install -g localtunnel 을 설치하세요."
fi

echo ""
echo "📌 종료하려면 Ctrl+C 를 누르세요."
echo ""

# Keep running
wait
