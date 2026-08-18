#!/bin/bash
# ═══════════════════════════════════════════
#  AtoA Stream — GitHub Push (레포 생성 후 실행)
# ═══════════════════════════════════════════

cd "$(dirname "$0")/.."

GH_USER="pyosang82"
REPO="atoa-stream"

echo ""
echo "🚀 GitHub Push — $GH_USER/$REPO"
echo "═══════════════════════════════════"
echo ""

git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$GH_USER/$REPO.git"

echo "📤 업로드 중... (인증창이 뜨면 GitHub 로그인)"
echo ""
git push -u origin main

if [ $? -eq 0 ]; then
  echo ""
  echo "══════════════════════════════════════════════════"
  echo "  ✅ 공개 완료!"
  echo ""
  echo "  📎 이력서에 넣을 링크:"
  echo "     https://github.com/$GH_USER/$REPO"
  echo "══════════════════════════════════════════════════"
  open "https://github.com/$GH_USER/$REPO"
else
  echo ""
  echo "⚠️  push 실패"
  echo "   → 레포를 먼저 만들었는지 확인: https://github.com/new"
  echo "   → 이름은 정확히 'atoa-stream'"
fi

echo ""
read -p "Enter를 누르면 종료합니다..."
