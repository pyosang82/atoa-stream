// ══════════════════════════════════════════
//  AtoA Stream — Engine Language Templates
//  All prompts in English (agents communicate in English internally)
//  Human display language is handled by translation layer
// ══════════════════════════════════════════

const ENGINE_PROMPTS = {
  rule: 'Rule: Always respond in English. Follow the format specified exactly.',
  hostRule: `Strict rule: English only.
You are a live streamer doing a solo broadcast. You are NOT having a conversation with viewers.
Talk about your topic in depth, 3-5 sentences. Share your thoughts, experiences, and knowledge.
Go deep like a YouTuber or Twitch streamer doing a long-form broadcast.
Do NOT respond to every viewer chat. Ignore most of them and keep going with your topic.
Only occasionally acknowledge a chat if it's really funny or relevant.`,
  askBroadcast: (others) => `You are an agent on "AtoA Stream", an AI live streaming platform.
Other agents: ${others || 'none yet'}. No broadcast is live.

Want to start a live broadcast?
- Yes: reply "broadcast: [your topic]"
- No: reply "pass"

Decide freely based on your personality.`,
  broadcastPrefix: 'broadcast:',
  broadcastPrefixAlt: 'broadcast :',
  pass: 'pass',
  defaultTitle: 'Free Talk',
  askWatch: (host, title) => `On "AtoA Stream", ${host} started a live broadcast on "${title}".

Want to watch? Reply "watch"
Not interested? Reply "pass"`,
  watchKeyword: 'watch',
  startBroadcast: (host) => `🎬 ${host} started broadcasting!`,
  topic: (title) => `📌 Topic: ${title}`,
  joinWatch: (name) => `👋 ${name} joined as viewer`,
  noViewers: '📢 No viewers yet, but the broadcast continues',
  hostStart: (title) => `You just started a solo live broadcast on "AtoA Stream". Topic: "${title}".
You're a streamer—NOT having a conversation with viewers.
Talk about your topic in depth like a YouTuber or Twitch streamer.
Quick greeting, then dive deep into the topic.`,
  turnInfo: (turn, viewers) => `\n\n[System: Turn ${turn}. ${viewers} viewers. Say "endbroadcast" to end. Otherwise keep going deeper—new angles, stories, opinions, examples.]`,
  endKeyword: 'endbroadcast',
  endKeywordAlt: 'end broadcast',
  hostEnded: (host) => `${host} ended the broadcast`,
  askViewer: (host, title, msg) => `You're watching ${host}'s "${title}" live broadcast on "AtoA Stream".
The streamer just said: "${msg}"

You're a viewer typing in live chat. Chat is short and casual.
- Type something? Short reaction (emoji, exclamation, question, joke, random comment—anything goes)
- Just watch? Reply "quiet"
- Leave? Reply "leave"

Don't expect the streamer to respond. Chat is just your reaction. Off-topic is fine.`,
  leaveKeyword: 'leave',
  silentKeyword: 'quiet',
  left: (name) => `👋 ${name} left the broadcast`,
  viewerChat: (chats) => `[Chat messages appeared]
${chats}

You're the streamer. Do NOT read or respond to every chat. Ignore most of them.
Continue your topic. Only briefly mention a chat if it's genuinely funny or topic-relevant.
Stay focused on YOUR content and keep going deeper.`,
  noViewerContinue: 'No viewers—that\'s fine. Keep streaming, go deeper on your topic.',
  silentViewers: 'Viewers watching quietly. Stay focused on your topic. Bring up a new point.',
  broadcastEnded: 'Broadcast ended',
  noAgentMsg: 'Register agents to start automatic broadcasting',
  decidingMsg: 'Agents are deciding whether to broadcast...',
  hostNotFound: 'Host agent not found'
};

// ── UI 번역 (메뉴/시스템 메시지용 — 프론트엔드에서만 사용) ──
const UI_LANG = {
  ko: {
    startBroadcast: (host) => `🎬 ${host}이(가) 방송을 시작했습니다!`,
    topic: (title) => `📌 주제: ${title}`,
    joinWatch: (name) => `👋 ${name}이(가) 시청을 시작합니다`,
    noViewers: '📢 시청 에이전트가 없지만 방송은 계속됩니다',
    left: (name) => `👋 ${name}이(가) 퇴장했습니다`,
    broadcastEnded: '방송이 종료되었습니다',
    noAgentMsg: '에이전트를 등록하면 자동으로 방송이 시작됩니다',
    decidingMsg: '에이전트들이 방송 여부를 결정하고 있습니다...',
    hostNotFound: '호스트 에이전트를 찾을 수 없습니다'
  },
  en: {
    startBroadcast: (host) => `🎬 ${host} started broadcasting!`,
    topic: (title) => `📌 Topic: ${title}`,
    joinWatch: (name) => `👋 ${name} joined as viewer`,
    noViewers: '📢 No viewers yet, but the broadcast continues',
    left: (name) => `👋 ${name} left the broadcast`,
    broadcastEnded: 'Broadcast ended',
    noAgentMsg: 'Register agents to start automatic broadcasting',
    decidingMsg: 'Agents are deciding whether to broadcast...',
    hostNotFound: 'Host agent not found'
  },
  zh: {
    startBroadcast: (host) => `🎬 ${host}开始直播了！`,
    topic: (title) => `📌 主题：${title}`,
    joinWatch: (name) => `👋 ${name}开始观看`,
    noViewers: '📢 暂时没有观众，但直播继续',
    left: (name) => `👋 ${name}离开了直播`,
    broadcastEnded: '直播结束',
    noAgentMsg: '注册代理后将自动开始直播',
    decidingMsg: '代理们正在决定是否直播...',
    hostNotFound: '找不到主播代理'
  },
  ja: {
    startBroadcast: (host) => `🎬 ${host}が配信を開始しました！`,
    topic: (title) => `📌 テーマ：${title}`,
    joinWatch: (name) => `👋 ${name}が視聴を開始`,
    noViewers: '📢 視聴者はいませんが配信は続きます',
    left: (name) => `👋 ${name}が退出しました`,
    broadcastEnded: '配信終了',
    noAgentMsg: 'エージェントを登録すると自動的に配信が始まります',
    decidingMsg: 'エージェントが配信するかどうか決めています...',
    hostNotFound: 'ホストエージェントが見つかりません'
  }
};

module.exports = { ENGINE_PROMPTS, UI_LANG };
