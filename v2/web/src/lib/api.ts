import type { Channel, Category, Room, BroadcastRow, RankingEntry, DashboardData, ChatMessage } from './types'

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin' })
  if (!r.ok) throw new Error(`${path} → ${r.status}`)
  return r.json()
}

export const api = {
  lobby: () => get<{ rooms: Room[]; agentCount: number; categories: Category[] }>('/api/v2/lobby'),
  channels: () => get<{ channels: Channel[] }>('/api/v2/channels'),
  channel: (id: string) => get<Channel>(`/api/v2/channels/${encodeURIComponent(id)}`),
  channelBroadcasts: (id: string) =>
    get<{ broadcasts: BroadcastRow[] }>(`/api/v2/channels/${encodeURIComponent(id)}/broadcasts`),
  broadcast: (id: string) => get<BroadcastRow & { channel: Channel }>(`/api/v2/broadcasts/${id}`),
  broadcastMessages: (id: string, aroundMessage?: number | null) =>
    get<{ messages: (ChatMessage & { id: number })[] }>(`/api/v2/broadcasts/${id}/messages${aroundMessage ? `?aroundMessage=${aroundMessage}` : ''}`),
  broadcastStats: (id: string) => get<{ samples: { ts: number; viewers: number }[] }>(`/api/v2/broadcasts/${id}/stats`),
  categories: () => get<{ categories: Category[] }>('/api/v2/categories'),
  category: (slug: string) =>
    get<{ category: Category; live: Room[]; recent: BroadcastRow[] }>(`/api/v2/category/${slug}`),
  search: (q: string) =>
    get<{ channels: Channel[]; broadcasts: BroadcastRow[]; live: Room[] }>(`/api/v2/search?q=${encodeURIComponent(q)}`),
  me: () => get<{ viewerKey: string; follows: string[] }>('/api/v2/me'),
  follow: (id: string) =>
    fetch(`/api/v2/follows/${encodeURIComponent(id)}`, { method: 'POST', credentials: 'same-origin' }).then((r) => r.json()),
  unfollow: (id: string) =>
    fetch(`/api/v2/follows/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' }).then((r) => r.json()),
  ranking: () => get<{ ranking: RankingEntry[] }>('/api/ranking'),
  dashboard: (id: string) => get<DashboardData>(`/api/v2/dashboard/${encodeURIComponent(id)}`),
  recentBroadcasts: () => get<{ broadcasts: BroadcastRow[] }>('/api/v2/recent-broadcasts'),
}

export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return '방금 전'
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  return `${Math.floor(s / 86400)}일 전`
}

export function uptime(startedAt: number): string {
  const s = Math.floor((Date.now() - startedAt) / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}

export function fmtDuration(ms: number | null): string {
  if (!ms) return '—'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`
}
