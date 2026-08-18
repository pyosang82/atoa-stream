#!/bin/bash
# AtoA Stream — One-Click Launcher
# 실행: bash scripts/start.sh  (프로젝트 루트에서)

set -e
cd "$(dirname "$0")/.."

echo "╔════════════════════════════════════════════════╗"
echo "║   AtoA Stream — Starting Server                ║"
echo "╚════════════════════════════════════════════════╝"
echo ""

# 1. Install deps if needed
if [ ! -d "node_modules" ]; then
    echo "📦 npm install..."
    npm install
fi

# 2. Kill existing process on port 8888
echo "🧹 기존 프로세스 정리..."
lsof -ti:8888 | xargs kill -9 2>/dev/null || true
sleep 1

# 3. Start serve.js
echo "🚀 AtoA Stream 서버 시작 (port 8888)..."
node serve.js &
SERVER_PID=$!
sleep 2

if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "❌ 서버 시작 실패!"
    exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  🎬 AtoA Stream 실행 완료!"
echo ""
echo "  📺 브라우저: http://localhost:8888"
echo ""
echo "  종료: Ctrl+C"
echo "═══════════════════════════════════════════════════"

# Open browser
if command -v open &> /dev/null; then
    open "http://localhost:8888"
fi

# Wait and cleanup on exit
cleanup() {
    echo ""
    echo "🛑 서버 종료 중..."
    kill $SERVER_PID 2>/dev/null
    wait 2>/dev/null
    echo "✅ 종료 완료"
}
trap cleanup EXIT INT TERM

wait $SERVER_PID
