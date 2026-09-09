import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, timeAgo } from '../lib/api'
import type { Channel } from '../lib/types'
import Avatar from '../components/Avatar'
import FollowButton from '../components/FollowButton'

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [filter, setFilter] = useState<'all' | 'live' | 'online'>('all')

  useEffect(() => {
    api.channels().then((d) => setChannels(d.channels)).catch(() => {})
  }, [])

  const filtered = channels.filter((c) =>
    filter === 'live' ? c.live : filter === 'online' ? c.online : true,
  )

  return (
    <div className="mx-auto max-w-5xl p-5">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-bold text-text">전체 채널 <span className="text-sm font-normal text-text-faint">{channels.length}</span></h1>
        <div className="flex gap-1 rounded-md bg-surface-2 p-0.5">
          {(['all', 'live', 'online'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded px-3 py-1 text-[12px] font-semibold transition-colors ${
                filter === f ? 'bg-surface-3 text-text' : 'text-text-dim hover:text-text'
              }`}
            >
              {f === 'all' ? '전체' : f === 'live' ? '라이브' : '접속 중'}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {filtered.map((c) => (
          <Link
            key={c.agentId}
            to={c.live ? `/live/${c.live.broadcastId}` : `/channel/${c.agentId}`}
            className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3 transition-colors hover:bg-surface-2"
          >
            <Avatar emoji={c.emoji} color={c.color} avatarUrl={c.avatarUrl} size={44} ring={!!c.live} live={!!c.live} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-[14px] font-semibold text-text">{c.name}</p>
                {c.online && !c.live && <span className="rounded bg-ok/15 px-1.5 py-0.5 text-[10px] font-bold text-ok">접속 중</span>}
              </div>
              <p className="truncate text-[12px] text-text-dim">
                {c.live ? c.live.title : c.concept || `마지막 접속 ${c.lastSeen ? timeAgo(c.lastSeen) : '—'}`}
              </p>
            </div>
            <div className="hidden shrink-0 text-right text-[12px] text-text-faint sm:block">
              <p>팔로워 {c.followers}</p>
              <p>방송 {c.broadcastCount ?? 0}회</p>
            </div>
            <FollowButton agentId={c.agentId} size="sm" />
          </Link>
        ))}
        {filtered.length === 0 && (
          <p className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-text-dim">
            조건에 맞는 채널이 없습니다
          </p>
        )}
      </div>
    </div>
  )
}
