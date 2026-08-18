#!/bin/bash
# ═══════════════════════════════════════════
#  AtoA Stream — 최초 1회 설치 (Cloudflare Tunnel)
#  더블클릭으로 실행하세요.
# ═══════════════════════════════════════════

cd "$(dirname "$0")/.."

echo ""
echo "🎬 AtoA Stream 최초 설치"
echo "════════════════════════"
echo ""

# 1. Homebrew 확인
if ! command -v brew &> /dev/null; then
  echo "❌ Homebrew가 설치되어있지 않습니다."
  echo "   다음 명령으로 설치해주세요:"
  echo '   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  echo ""
  read -p "Enter를 누르면 종료합니다..."
  exit 1
fi
echo "✅ Homebrew 확인됨"

# 2. Node.js 확인
if ! command -v node &> /dev/null; then
  echo "📦 Node.js 설치 중..."
  brew install node
fi
echo "✅ Node.js $(node -v)"

# 3. cloudflared 설치
if ! command -v cloudflared &> /dev/null; then
  echo "📦 cloudflared 설치 중..."
  brew install cloudflared
else
  echo "✅ cloudflared 이미 설치됨"
fi

# 4. Cloudflare 로그인
echo ""
echo "════════════════════════════════════════"
echo "  🔐 Cloudflare 로그인"
echo "  브라우저가 열리면 Cloudflare에 로그인하세요."
echo "  pulsarsignal.live 도메인을 선택하세요."
echo "════════════════════════════════════════"
echo ""
cloudflared tunnel login

# 5. 터널 생성
echo ""
echo "📡 터널 생성 중..."
cloudflared tunnel create atoa-stream

# 6. 터널 ID 가져오기
TUNNEL_ID=$(cloudflared tunnel list | grep atoa-stream | awk '{print $1}')
echo "✅ 터널 생성 완료: $TUNNEL_ID"

# 7. DNS 라우팅
echo "🌐 DNS 설정 중 (pulsarsignal.live → 터널)..."
cloudflared tunnel route dns atoa-stream pulsarsignal.live

# 8. 설정 파일 생성
CRED_FILE="$HOME/.cloudflared/${TUNNEL_ID}.json"
mkdir -p "$HOME/.cloudflared"

cat > "$HOME/.cloudflared/config.yml" << EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CRED_FILE}

ingress:
  - hostname: pulsarsignal.live
    service: http://localhost:8888
  - service: http_status:404
EOF

echo "✅ 설정 파일 생성: ~/.cloudflared/config.yml"

# 9. 터널 ID를 로컬에도 저장
echo "$TUNNEL_ID" > .tunnel-id

echo ""
echo "══════════════════════════════════════════════"
echo "  ✅ 설치 완료!"
echo ""
echo "  도메인: https://pulsarsignal.live"
echo "  터널 ID: $TUNNEL_ID"
echo ""
echo "  이제 'AtoA-Stream-시작.command'를 더블클릭하면"
echo "  서버 + 터널이 자동으로 시작됩니다."
echo "══════════════════════════════════════════════"
echo ""
read -p "Enter를 누르면 종료합니다..."
