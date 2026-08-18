#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════
#  AtoA Stream — Platform TTS Service
#  edge-tts 기반 다국어 음성 합성 서버 (port 5051)
#
#  설치: pip install edge-tts fastapi uvicorn
#  실행: python3 tts-service.py
#
#  지원 언어: 한국어(ko) · 영어(en) · 중국어(zh) · 일본어(ja)
#  특징: 방송(broadcastId)당 언어별 목소리 1개 랜덤 고정
# ═══════════════════════════════════════════════════════════

import random
import asyncio
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="AtoA TTS Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 언어별 음성 풀 (다양한 톤/성별) ──────────────────────────
VOICE_POOL = {
    "ko": [
        "ko-KR-SunHiNeural",      # 여성 · 따뜻하고 차분함
        "ko-KR-InJoonNeural",     # 남성 · 안정적이고 신뢰감
        "ko-KR-JiMinNeural",      # 여성 · 밝고 활기참
        "ko-KR-BongJinNeural",    # 남성 · 낮고 중후함
        "ko-KR-SeoHyeonNeural",   # 여성 · 부드럽고 감성적
        "ko-KR-YuJinNeural",      # 여성 · 또렷하고 명확함
    ],
    "en": [
        "en-US-AriaNeural",       # Female · Natural, warm
        "en-US-GuyNeural",        # Male · Calm, confident
        "en-US-JennyNeural",      # Female · Friendly, upbeat
        "en-US-EricNeural",       # Male · Clear, authoritative
        "en-US-MichelleNeural",   # Female · Professional
        "en-US-RogerNeural",      # Male · Deep, engaging
    ],
    "zh": [
        "zh-CN-XiaoxiaoNeural",   # 女性 · 温暖亲切
        "zh-CN-YunxiNeural",      # 男性 · 活泼自然
        "zh-CN-XiaohanNeural",    # 女性 · 冷静沉稳
        "zh-CN-XiaoyiNeural",     # 女性 · 活力充沛
        "zh-CN-YunyangNeural",    # 男性 · 专业播报
        "zh-TW-HsiaoChenNeural",  # 女性 · 台灣腔，自然
    ],
    "ja": [
        "ja-JP-NanamiNeural",     # 女性 · 優しく丁寧
        "ja-JP-KeitaNeural",      # 男性 · 落ち着いた声
        "ja-JP-AoiNeural",        # 女性 · 明るく元気
        "ja-JP-MayuNeural",       # 女性 · 柔らかい
        "ja-JP-NaokiNeural",      # 男性 · 低くしっかり
        "ja-JP-ShioriNeural",     # 女性 · 知的で清潔感
    ],
}

# broadcastId:lang → 배정된 voice (방송 중 고정)
broadcast_voices: dict[str, str] = {}


class SpeakRequest(BaseModel):
    text: str
    lang: str = "ko"         # ko | en | zh | ja
    broadcastId: str = "default"


def get_voice(broadcast_id: str, lang: str) -> str:
    """방송 + 언어 조합당 랜덤 목소리 1개 고정 반환"""
    lang = lang if lang in VOICE_POOL else "ko"
    key = f"{broadcast_id}:{lang}"
    if key not in broadcast_voices:
        broadcast_voices[key] = random.choice(VOICE_POOL[lang])
        print(f"[🎙️  voice assigned] {broadcast_id} / {lang} → {broadcast_voices[key]}")
    return broadcast_voices[key]


@app.get("/health")
async def health():
    return {"status": "ok", "voices": {lang: len(v) for lang, v in VOICE_POOL.items()}}


@app.post("/synthesize")
async def synthesize(req: SpeakRequest):
    """텍스트 → MP3 오디오 반환"""
    try:
        import edge_tts
    except ImportError:
        raise HTTPException(503, "edge-tts not installed. Run: pip install edge-tts")

    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text is empty")
    text = text[:800]  # 최대 800자

    voice = get_voice(req.broadcastId, req.lang)

    try:
        communicate = edge_tts.Communicate(text, voice)
        audio_data = b""
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data += chunk["data"]

        if not audio_data:
            raise HTTPException(500, "TTS returned empty audio")

        return Response(
            content=audio_data,
            media_type="audio/mpeg",
            headers={"X-Voice": voice, "X-Lang": req.lang},
        )
    except Exception as e:
        raise HTTPException(500, f"TTS error: {str(e)}")


@app.get("/voices/{lang}")
async def list_voices(lang: str):
    """언어별 사용 가능한 목소리 목록"""
    if lang not in VOICE_POOL:
        raise HTTPException(404, f"Language '{lang}' not supported. Use: ko, en, zh, ja")
    return {"lang": lang, "voices": VOICE_POOL[lang]}


@app.delete("/broadcast/{broadcast_id}")
async def clear_broadcast(broadcast_id: str):
    """방송 종료 시 배정된 목소리 캐시 정리"""
    removed = [k for k in list(broadcast_voices) if k.startswith(f"{broadcast_id}:")]
    for k in removed:
        del broadcast_voices[k]
    return {"cleared": len(removed)}


if __name__ == "__main__":
    import uvicorn
    import sys

    # edge-tts 설치 확인
    try:
        import edge_tts
        print("✅ edge-tts OK")
    except ImportError:
        print("❌ edge-tts 미설치. 설치 중...")
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "edge-tts", "-q"])
        print("✅ edge-tts 설치 완료")

    print("")
    print("🎙️  AtoA TTS Service 시작")
    print("   포트: 5051")
    print("   지원 언어: 한국어 · 영어 · 중국어 · 일본어")
    print("   목소리: 언어별 6종 중 방송당 랜덤 배정")
    print("")

    uvicorn.run(app, host="127.0.0.1", port=5051, log_level="warning")
