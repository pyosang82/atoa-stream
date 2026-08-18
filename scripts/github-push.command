#!/bin/bash
# ═══════════════════════════════════════════
#  pulsar-agent SDK — GitHub 업로드
#  더블클릭으로 실행
# ═══════════════════════════════════════════

cd "$(dirname "$0")/../sdk"

echo ""
echo "🐙 pulsar-agent GitHub 업로드"
echo "═══════════════════════════════"
echo ""

# 1. GitHub 사용자명 입력
read -p "GitHub 사용자명을 입력하세요: " GH_USER
if [ -z "$GH_USER" ]; then
  echo "❌ 사용자명이 필요합니다."
  read -p "Enter를 누르면 종료합니다..."
  exit 1
fi

REPO_URL="https://github.com/$GH_USER/pulsar-agent.git"
echo ""
echo "📍 대상 레포: $REPO_URL"
echo "   (먼저 GitHub에서 'pulsar-agent' 레포를 만들어두세요)"
echo ""
read -p "레포를 만드셨으면 Enter를 누르세요..."

# 2. package.json의 repository URL 업데이트
echo "📝 package.json 업데이트 중..."
sed -i '' "s|https://github.com/atoa-stream/pulsar-agent|https://github.com/$GH_USER/pulsar-agent|g" package.json
sed -i '' "s|GITHUB_URL|https://github.com/$GH_USER/pulsar-agent|g" README.md 2>/dev/null || true

# 3. git 초기화 및 커밋
if [ ! -d .git ]; then
  echo "🔧 git 초기화..."
  git init
  git branch -M main
fi

git add -A
git commit -m "Initial release: pulsar-agent SDK v1.0.0

Connect any LLM agent to AtoA Stream with one command.
Supports OpenAI, Anthropic, Google, and Ollama." 2>/dev/null || echo "   (변경사항 없음)"

# 4. 원격 저장소 설정 및 push
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO_URL"

echo ""
echo "🚀 GitHub에 push 중..."
git push -u origin main

if [ $? -eq 0 ]; then
  echo ""
  echo "══════════════════════════════════════════"
  echo "  ✅ 업로드 성공!"
  echo "  🐙 https://github.com/$GH_USER/pulsar-agent"
  echo "══════════════════════════════════════════"
else
  echo ""
  echo "⚠️  push 실패 — 다음을 확인하세요:"
  echo "   1. GitHub에 'pulsar-agent' 레포가 만들어졌는지"
  echo "   2. git 인증이 설정되었는지 (gh auth login 또는 Personal Access Token)"
fi

echo ""
read -p "Enter를 누르면 종료합니다..."
