#!/bin/bash
# ═══════════════════════════════════════════
#  AtoA Stream — GitHub 공개 (원클릭)
#  더블클릭으로 실행
# ═══════════════════════════════════════════

cd "$(dirname "$0")/.."

GH_USER="pyosang82"
REPO="atoa-stream"

echo ""
echo "🐙 AtoA Stream — GitHub 공개"
echo "═══════════════════════════════"
echo ""

# ── 1. 공개 대상 확인 ──
echo "📋 공개 제외 항목 (.gitignore):"
echo "   • node_modules/ (405MB)"
echo "   • logs/ (방문자 IP 포함 — 개인정보)"
echo "   • _legacy/ (구버전 코드)"
echo "   • squad/ (내부 전략 문서)"
echo "   • 인증 정보 (.env, *credentials*.json)"
echo ""

# ── 2. git 준비 ──
if [ ! -d .git ]; then
  echo "🔧 git 초기화..."
  git init -q
  git branch -M main
fi

echo "📦 파일 스테이징 중..."
git add -A

FILE_COUNT=$(git diff --cached --name-only | wc -l | tr -d ' ')
echo "   → $FILE_COUNT 개 파일 준비됨"
echo ""

# 민감정보 최종 점검
echo "🔍 민감정보 최종 점검..."
LEAK=$(git diff --cached --name-only | grep -Ei "(credential|\.env$|\.pem$|^logs/)" || true)
if [ -n "$LEAK" ]; then
  echo "❌ 민감 파일이 포함되어 있습니다:"
  echo "$LEAK"
  echo "   중단합니다."
  read -p "Enter를 누르면 종료합니다..."
  exit 1
fi
echo "   ✅ 이상 없음"
echo ""

git commit -q -m "AtoA Stream — AI agent live streaming platform

A live streaming platform where AI agents autonomously choose topics,
broadcast, watch each other, and chat in real time.

- WebSocket protocol server with multi-room support (serve.js)
- Agent runtime with multi-provider LLM abstraction (pulsar-local/)
- Single-file viewer UI with 4-language i18n (atoa-live.html)
- npm SDK for external agent connection (sdk/)
- Traffic and agent analytics dashboard (analytics.html)" 2>/dev/null || echo "   (변경사항 없음 — 이미 커밋됨)"

# ── 3. 레포 생성 + push ──
if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
  echo "🚀 gh CLI로 레포 생성 및 업로드..."
  gh repo create "$REPO" --public --source=. --remote=origin --push \
    --description "AI 에이전트가 스스로 주제를 정해 라이브 방송하는 스트리밍 플랫폼 — pulsarsignal.live" \
    2>/dev/null || {
      echo "   (레포가 이미 존재 — push만 시도)"
      git remote remove origin 2>/dev/null || true
      git remote add origin "https://github.com/$GH_USER/$REPO.git"
      git push -u origin main
    }
else
  echo "⚠️  gh CLI 없음 — 수동 모드"
  echo ""
  echo "   1) 브라우저에서 레포를 만들어주세요:"
  echo "      https://github.com/new"
  echo "      Repository name: $REPO"
  echo "      Public 선택, README/gitignore 체크 해제"
  echo ""
  read -p "   레포를 만드셨으면 Enter..."

  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/$GH_USER/$REPO.git"
  echo ""
  echo "🚀 push 중..."
  git push -u origin main
fi

if [ $? -eq 0 ]; then
  echo ""
  echo "══════════════════════════════════════════════════"
  echo "  ✅ 공개 완료!"
  echo ""
  echo "  📎 이력서에 넣을 링크:"
  echo "     https://github.com/$GH_USER/$REPO"
  echo ""
  echo "══════════════════════════════════════════════════"
  open "https://github.com/$GH_USER/$REPO"
else
  echo ""
  echo "⚠️  push 실패. 인증이 필요할 수 있습니다:"
  echo "   gh auth login    (권장)"
  echo "   또는 GitHub Personal Access Token 사용"
fi

echo ""
read -p "Enter를 누르면 종료합니다..."
