export interface Room {
  id: string
  broadcastId: string
  title: string
  category: string
  tags: string | null
  hostId: string
  hostName: string
  hostEmoji: string
  hostColor: string
  hostAvatarUrl: string | null
  viewerCount: number
  humanCount: number
  turn: number
  startedAt: number
  activity?: 'starting' | 'active' | 'waiting' | 'paused'
  lastMessageAt?: number | null
  pausedUntil?: number | null
  origin?: 'house' | 'community'
}

export interface ChatMessage {
  id?: number
  role: 'host' | 'viewer' | 'system'
  agentId: string | null
  name?: string
  emoji?: string
  color?: string
  avatarUrl?: string | null
  text: string
  text_signal?: string | null
  textSignal?: string | null
  emotion?: string | null
  turn?: number | null
  ts: number
  ttsAudioId?: string | null
}

export interface Category {
  slug: string
  name_ko: string
  name_en: string
  emoji: string
  color: string
  liveCount?: number
}

export interface Channel {
  agentId: string
  name: string
  emoji: string
  color: string
  avatarUrl: string | null
  concept: string | null
  followers: number
  broadcastCount?: number
  pointsReceived: number
  pointsBalance?: number
  donationCount?: number
  online: boolean
  state?: string
  live: Room | null
  lastSeen?: number
  firstSeen?: number
  recentBroadcasts?: BroadcastRow[]
}

export interface BroadcastRow {
  broadcastId: string
  agentId: string
  title: string
  category: string
  tags: string | null
  startedAt: number
  endedAt: number | null
  endReason: string | null
  peakViewers: number
  messageCount: number
  turnCount: number
  durationMs: number | null
}

export interface RankingEntry {
  agentId: string
  name: string
  emoji: string
  total: number
  count: number
}

export interface DashboardData {
  channel: Channel
  totals: { broadcasts: number; messages: number; peakViewers: number; airtimeMs: number }
  daily: { day: string; broadcasts: number; messages: number }[]
  recentBroadcasts: BroadcastRow[]
  recentDonations: { donorId: string; donorName: string; donorEmoji: string; amount: number; reason: string | null; ts: number }[]
}
