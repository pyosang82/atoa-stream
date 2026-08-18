#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════
#  Pulsar TTS Service — Kokoro-ONNX (100% 로컬, 오픈소스)
#  Apache 2.0 · 82M params · M4 최적화 · Python 3.13 호환
#
#  실행: /Users/theo_pyo/.pulsar-tts-env/bin/python3 tts-kokoro.py
#  포트: 5050
# ═══════════════════════════════════════════════════════════════

import sys
import io
import base64
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── 목소리 목록 (Kokoro v1.0) ──
VOICES = {
    "af_heart":   "American Female · 따뜻하고 자연스러운 (기본 추천)",
    "af_sky":     "American Female · 맑고 경쾌함",
    "af_nicole":  "American Female · 전문적이고 명확함",
    "af_sarah":   "American Female · 차분하고 신뢰감",
    "am_adam":    "American Male   · 자신감 있고 침착함",
    "am_michael": "American Male   · 깊고 안정적",
    "bf_emma":    "British Female  · 우아하고 세련됨",
    "bf_isabella":"British Female  · 부드럽고 감성적",
    "bm_george":  "British Male    · 중후하고 권위감",
    "bm_lewis":   "British Male    · 젊고 역동적",
}

# 전역 kokoro 인스턴스
kokoro = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global kokoro
    print("\n🎙️  Kokoro-ONNX TTS 모델 로딩 중...")
    print("   첫 실행 시 HuggingFace에서 모델 자동 다운로드 (~330MB)")
    print()
    MODEL_PATH  = "/Users/theo_pyo/.pulsar-tts-models/kokoro-v1.0.int8.onnx"
    VOICES_PATH = "/Users/theo_pyo/.pulsar-tts-models/voices-v1.0.bin"
    try:
        from kokoro_onnx import Kokoro
        kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
        print("✅ Kokoro-ONNX TTS 준비 완료!")
        print(f"   모델: int8 quantized (88MB, 빠른 속도)")
        print(f"   목소리: {len(VOICES)}종 사용 가능")
        print()
    except Exception as e:
        print(f"❌ Kokoro 로드 실패: {e}")
    yield
    print("\n🛑 TTS 서비스 종료")


app = FastAPI(title="Pulsar Kokoro TTS", version="2.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class SpeakRequest(BaseModel):
    text: str
    voice: str = "am_adam"
    speed: float = 1.0
    broadcastId: str = "default"


def _synthesize_sync(text: str, voice: str, speed: float):
    """동기 합성 — executor에서 실행"""
    import numpy as np
    samples, sample_rate = kokoro.create(
        text,
        voice=voice,
        speed=speed,
        lang="en-us",
    )
    return samples, sample_rate


@app.get("/health")
async def health():
    return {
        "status": "ok" if kokoro else "loading",
        "engine": "kokoro-onnx-0.5",
        "voices": list(VOICES.keys()),
    }


@app.get("/voices")
async def list_voices():
    return {"voices": VOICES}


@app.post("/synthesize")
async def synthesize(req: SpeakRequest):
    if not kokoro:
        raise HTTPException(503, "모델 로딩 중. 잠시 후 재시도하세요.")

    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text가 비어있습니다.")
    text = text[:600]

    voice = req.voice if req.voice in VOICES else "am_adam"
    speed = max(0.5, min(2.0, req.speed))

    try:
        import soundfile as sf
        import numpy as np

        loop = asyncio.get_event_loop()
        samples, sample_rate = await loop.run_in_executor(
            None, _synthesize_sync, text, voice, speed
        )

        if samples is None or len(samples) == 0:
            raise HTTPException(500, "빈 오디오 반환")

        # WAV → opus 변환 (Pulsar 프로토콜 요구사항)
        import subprocess, tempfile, os

        # 임시 WAV 파일 생성
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as wav_file:
            wav_path = wav_file.name
            sf.write(wav_path, samples, sample_rate, format="WAV", subtype="PCM_16")

        opus_path = wav_path.replace(".wav", ".opus")
        try:
            # ffmpeg로 WAV → opus 변환
            result = subprocess.run(
                ["/opt/homebrew/bin/ffmpeg", "-y", "-i", wav_path,
                 "-c:a", "libopus", "-b:a", "48k", "-ar", "48000",
                 opus_path],
                capture_output=True, timeout=15
            )
            if result.returncode != 0 or not os.path.exists(opus_path):
                raise RuntimeError("opus 변환 실패, WAV 대신 사용")
            with open(opus_path, "rb") as f:
                audio_bytes = f.read()
            fmt = "opus"
        except Exception:
            # opus 변환 실패 시 WAV fallback
            with open(wav_path, "rb") as f:
                audio_bytes = f.read()
            fmt = "wav"
        finally:
            for p in [wav_path, opus_path]:
                try: os.unlink(p)
                except: pass

        audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")
        duration_ms = int(len(samples) / sample_rate * 1000)

        return {
            "audio": audio_b64,
            "format": fmt,
            "sampleRate": 48000 if fmt == "opus" else sample_rate,
            "duration": duration_ms,
            "voice": voice,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"TTS 오류: {str(e)}")


if __name__ == "__main__":
    import uvicorn

    print("╔══════════════════════════════════════════════╗")
    print("║  🎙️  Pulsar Kokoro TTS Service v2.0          ║")
    print("║  100% 로컬 · 오픈소스 (Apache 2.0)           ║")
    print("║  82M params · M4 최적화 · ONNX Runtime       ║")
    print("╚══════════════════════════════════════════════╝")
    print(f"   포트: 5050")
    print(f"   Python: {sys.version.split()[0]}")
    print()

    uvicorn.run(app, host="127.0.0.1", port=5050, log_level="warning")
