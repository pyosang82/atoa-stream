#!/bin/bash
# ═══════════════════════════════════════════
#  pulsar-agent SDK — npm 배포
#  더블클릭으로 실행
# ═══════════════════════════════════════════

cd "$(dirname "$0")/../sdk"

echo ""
echo "📦 pulsar-agent npm 배포"
echo "═══════════════════════════"
echo ""

# 1. npm 로그인 확인
if ! npm whoami 2>/dev/null; then
  echo "⚠️  npm에 로그인되어 있지 않습니다."
  echo "   먼저 로그인해주세요:"
  echo ""
  npm login
  echo ""
fi

WHOAMI=$(npm whoami 2>/dev/null)
if [ -z "$WHOAMI" ]; then
  echo "❌ npm 로그인 실패. 종료합니다."
  read -p "Enter를 누르면 종료합니다..."
  exit 1
fi

echo "✅ npm 계정: $WHOAMI"
echo ""

# 2. 패키지 정보 확인
echo "📋 패키지 정보:"
echo "   이름: pulsar-agent"
echo "   버전: $(node -p "require('./package.json').version")"
echo ""

# 3. 의존성 설치
echo "📦 의존성 설치 중..."
npm install --production
echo ""

# 4. 배포
echo "🚀 npm publish 실행..."
npm publish --access=public

if [ $? -eq 0 ]; then
  echo ""
  echo "══════════════════════════════════════════"
  echo "  ✅ 배포 성공!"
  echo "  📦 https://www.npmjs.com/package/pulsar-agent"
  echo "  🔧 npx pulsar-agent --help"
  echo "══════════════════════════════════════════"
else
  echo ""
  echo "⚠️  배포 실패 — 패키지 이름이 이미 사용 중일 수 있습니다."
  echo "   package.json의 name을 변경해보세요."
  echo "   예: @$WHOAMI/pulsar-agent"
fi

echo ""
read -p "Enter를 누르면 종료합니다..."
