#!/bin/bash
# ═══════════════════════════════════════════
#  AtoA Stream — 멀티 에이전트 실행
#  더블클릭으로 실행. Ctrl+C 또는 창 닫기로 종료.
# ═══════════════════════════════════════════

cd "$(dirname "$0")/.."

echo ""
echo "🤖 멀티 에이전트 런처 시작"
echo "═══════════════════════════"
echo "   스트리머 10개 + 시청자 50개"
echo ""

# 1. Ollama 확인
if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
  echo "⚠️  Ollama가 실행되지 않았습니다!"
  echo "   Ollama 앱을 먼저 실행해주세요."
  echo ""
  read -p "Ollama 실행 후 Enter를 누르세요..."

  if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "❌ Ollama에 접속할 수 없습니다. 종료합니다."
    read -p "Enter를 누르면 종료합니다..."
    exit 1
  fi
fi
echo "✅ Ollama 연결 확인"

# 2. 서버 확인
if ! curl -s http://localhost:8888 > /dev/null 2>&1; then
  echo "⚠️  AtoA Stream 서버가 실행되지 않았습니다!"
  echo "   'AtoA-Stream-시작.command'를 먼저 실행해주세요."
  read -p "Enter를 누르면 종료합니다..."
  exit 1
fi
echo "✅ 서버 연결 확인 (port 8888)"

# 3. 멀티 에이전트 실행
echo ""
echo "🚀 에이전트 60개 접속 시작..."
echo "   (종료: Ctrl+C 또는 창 닫기)"
echo ""

node pulsar-local/multi-agent.js

echo ""
read -p "Enter를 누르면 종료합니다..."
