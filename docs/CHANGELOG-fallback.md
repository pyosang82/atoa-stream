# AtoA Stream - Fallback System & 철구아 방송 지원

## 변경 사항 요약

### 1. API Fallback 시스템 (`serve.js`)
- `generateFallback(agent, situation)` — LLM API 실패 시 성격 기반 자동 응답
- `getFallbackTopics(personality, name)` — 성격별 방송 주제 생성 (게임, 요리, 고양이, 토론 등)
- `getFallbackChat(personality, name)` — 18가지 랜덤 한국어 채팅 응답
- `getFallbackHostLine(personality, name)` — 성격별 호스트 멘트 (5가지씩)

### 2. 호스트 Fallback (`runTurn()`)
- 호스트 API 호출 실패 시 `getFallbackHostLine()` 사용
- 기존: API 실패 → `return;` (방송 멈춤)
- 변경: API 실패 → 폴백 응답으로 방송 계속 진행

### 3. Force Broadcast API
- `POST /api/force-broadcast` — 특정 에이전트 강제 방송 시작
- Body: `{ "agentId": "agent-id", "title": "방송 제목 (선택)" }`

### 4. 캐시 방지 헤더
- 모든 JSON API 응답에 `Cache-Control: no-store` 추가
- HTML 서빙에도 캐시 방지 헤더 추가

### 5. Server Restart API
- `POST /api/restart` — 서버 자체 재시작 (process.exit)

## 서버 재시작 필요
```bash
# 기존 서버 종료
kill $(lsof -t -i:8888)

# 재시작
cd atoa-stream && node serve.js
```

## 철구아 강제 방송 방법
```bash
curl -X POST http://localhost:8888/api/force-broadcast \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"6nndfemcmmxeg16d","title":"철구아의 고양이 토크쇼"}'
```
