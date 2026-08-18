#!/bin/bash
# ═══════════════════════════════════════════════════
#  AtoA Stream — GitHub 공개 (전체 자동)
#  gh CLI 설치 → 인증 → 레포 생성 → 업로드
# ═══════════════════════════════════════════════════

cd "$(dirname "$0")/.."

GH_USER="pyosang82"
REPO="atoa-stream"
DESC="AI 에이전트가 스스로 주제를 정해 라이브 방송하는 스트리밍 플랫폼 — pulsarsignal.live"

echo ""
echo "🚀 AtoA Stream → GitHub 공개"
echo "═════════════════════════════════"
echo ""

# ── 1. gh CLI 확보 ──
if ! command -v gh &>/dev/null; then
  echo "📦 GitHub CLI 설치 중..."

  if command -v brew &>/dev/null; then
    brew install gh
  else
    echo "   Homebrew가 없어 직접 다운로드합니다..."
    ARCH=$(uname -m)
    [ "$ARCH" = "arm64" ] && GHARCH="arm64" || GHARCH="amd64"
    GHVER="2.63.2"
    TMP=$(mktemp -d)
    curl -sL "https://github.com/cli/cli/releases/download/v${GHVER}/gh_${GHVER}_macOS_${GHARCH}.zip" -o "$TMP/gh.zip"
    unzip -q "$TMP/gh.zip" -d "$TMP"
    mkdir -p "$HOME/.local/bin"
    cp "$TMP/gh_${GHVER}_macOS_${GHARCH}/bin/gh" "$HOME/.local/bin/gh"
    chmod +x "$HOME/.local/bin/gh"
    export PATH="$HOME/.local/bin:$PATH"
    rm -rf "$TMP"
  fi

  if ! command -v gh &>/dev/null; then
    export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
  fi
fi

if ! command -v gh &>/dev/null; then
  echo "❌ GitHub CLI 설치 실패"
  read -p "Enter를 누르면 종료합니다..."
  exit 1
fi
echo "✅ GitHub CLI 준비됨 ($(gh --version | head -1))"
echo ""

# ── 2. 인증 ──
if ! gh auth status &>/dev/null 2>&1; then
  echo "🔐 GitHub 인증이 필요합니다."
  echo "   → 잠시 후 화면에 8자리 코드가 나옵니다."
  echo "   → 브라우저가 열리면 그 코드를 붙여넣고 승인해주세요."
  echo "   (이미 Chrome에 로그인되어 있어 바로 진행됩니다)"
  echo ""
  sleep 2
  gh auth login --hostname github.com --git-protocol https --web
fi

if ! gh auth status &>/dev/null 2>&1; then
  echo "❌ 인증 실패"
  read -p "Enter를 누르면 종료합니다..."
  exit 1
fi
echo ""
echo "✅ 인증 완료 — $(gh api user --jq .login 2>/dev/null)"
echo ""

# ── 3. 커밋 상태 확인 ──
git rev-parse --git-dir &>/dev/null || { git init -q; git branch -M main; }
rm -f .git/index.lock 2>/dev/null

if [ -z "$(git log --oneline -1 2>/dev/null)" ]; then
  echo "📦 초기 커밋 생성 중..."
  git add -A
  git commit -q -m "AtoA Stream — AI agent live streaming platform"
fi

# 미커밋 변경분 반영
if [ -n "$(git status --porcelain)" ]; then
  echo "📦 변경사항 커밋 중..."
  git add -A
  git commit -q -m "Update: prepare for public release"
fi

echo "✅ 커밋 준비됨 ($(git rev-list --count HEAD) commits, $(git ls-files | wc -l | tr -d ' ') files)"
echo ""

# ── 4. 민감정보 최종 점검 ──
echo "🔍 민감정보 점검..."
LEAK=$(git ls-files | grep -Ei "(credential|\.env$|\.pem$|^logs/|^squad/|tunnel-id)" || true)
if [ -n "$LEAK" ]; then
  echo "❌ 민감 파일 발견 — 중단합니다:"
  echo "$LEAK"
  read -p "Enter를 누르면 종료합니다..."
  exit 1
fi
echo "   ✅ 이상 없음"
echo ""

# ── 5. 레포 생성 + 업로드 ──
echo "🐙 레포 생성 및 업로드 중..."
if gh repo view "$GH_USER/$REPO" &>/dev/null 2>&1; then
  echo "   (레포가 이미 존재 — push만 진행)"
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/$GH_USER/$REPO.git"
  git push -u origin main --force-with-lease 2>/dev/null || git push -u origin main
else
  gh repo create "$REPO" --public --source=. --remote=origin --push --description "$DESC"
fi

PUSH_OK=$?

# ── 6. 레포 설정 (토픽, 홈페이지) ──
if [ $PUSH_OK -eq 0 ]; then
  gh repo edit "$GH_USER/$REPO" \
    --homepage "https://pulsarsignal.live" \
    --add-topic "ai-agents" \
    --add-topic "live-streaming" \
    --add-topic "websocket" \
    --add-topic "multi-agent" \
    --add-topic "llm" \
    --add-topic "nodejs" &>/dev/null || true

  echo ""
  echo "══════════════════════════════════════════════════════"
  echo "  ✅ 공개 완료!"
  echo ""
  echo "  📎 이력서에 넣을 링크:"
  echo ""
  echo "     https://github.com/$GH_USER/$REPO"
  echo ""
  echo "══════════════════════════════════════════════════════"

  # 링크를 클립보드에 복사
  echo -n "https://github.com/$GH_USER/$REPO" | pbcopy
  echo "  📋 링크가 클립보드에 복사되었습니다 (Cmd+V로 붙여넣기)"
  echo ""

  open "https://github.com/$GH_USER/$REPO"
else
  echo ""
  echo "⚠️  업로드 실패 — 위 메시지를 확인해주세요."
fi

echo ""
read -p "Enter를 누르면 종료합니다..."
