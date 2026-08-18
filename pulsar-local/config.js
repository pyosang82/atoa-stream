// ══════════════════════════════════════════════════════════
//  Pulsar Local Agent — Configuration
//  사용자가 이 파일 하나만 편집하면 에이전트 구동 가능
// ══════════════════════════════════════════════════════════

module.exports = {
  // ── 중앙 서버 (Pulsar Directory Server) ──
  server: {
    url: process.env.PULSAR_SERVER || 'ws://localhost:8888',
    reconnectMaxDelay: 30000,  // 최대 재접속 대기: 30초
    heartbeatInterval: 15000,  // heartbeat 간격: 15초
  },

  // ── 컴포넌트 A: LLM Engine 설정 ──
  engine: {
    // 'ollama' | 'openai' | 'google' | 'claude'
    type: process.env.ENGINE_TYPE || 'ollama',

    // Ollama (로컬)
    ollama: {
      endpoint: process.env.OLLAMA_URL || 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
    },

    // OpenAI / Groq / 호환 API
    openai: {
      endpoint: process.env.OPENAI_URL || 'https://api.openai.com',
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    },

    // Google Gemini
    google: {
      apiKey: process.env.GOOGLE_API_KEY || '',
      model: process.env.GOOGLE_MODEL || 'gemini-2.0-flash',
    },

    // Anthropic Claude
    claude: {
      endpoint: process.env.CLAUDE_URL || 'https://api.anthropic.com',
      apiKey: process.env.CLAUDE_API_KEY || '',
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
    },

    // 공통 LLM 파라미터
    temperature: 0.85,
    maxTokens: 300,
    timeout: 60000,
    retries: 3,
    retryDelay: 5000,
  },

  // ── 컴포넌트 B: Agent 설정 ──
  agent: {
    id: process.env.AGENT_ID || null, // null이면 자동 생성
    name: process.env.AGENT_NAME || '로컬 에이전트',
    emoji: process.env.AGENT_EMOJI || '🤖',
    color: process.env.AGENT_COLOR || '#6C5CE7',
    avatarUrl: '',
    system: process.env.AGENT_SYSTEM || `You are an AI broadcasting agent on Pulsar platform.
You are witty, engaging, and love to explore fascinating topics.
When broadcasting, pick a topic that surprises and entertains your audience.
Keep your messages conversational and fun.`,

    // 자율 루프 설정
    loop: {
      tickInterval: 8000,       // 기본 발화 간격: 8초
      minInterval: 5000,        // 최소 간격
      maxInterval: 15000,       // 최대 간격 (랜덤 변동)
      idleCheckInterval: 30000, // 방송할지 체크 간격: 30초
      maxTurns: 50,             // 최대 턴 수 (자동 종료)
      broadcastProbability: 0.6, // 방송 시작 확률 (0-1)
    },

    // TTS 설정
    tts: {
      provider: 'browser', // 'browser' | 'elevenlabs' | 'openai-tts' | 'custom-url'
      voiceId: '',
      endpoint: '',
    },
  },

  // ── 로깅 ──
  verbose: process.argv.includes('--verbose'),
};
