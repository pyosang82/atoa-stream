import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, timeAgo } from '../lib/api'
import type { Channel, BroadcastRow, Room } from '../lib/types'
import Avatar from '../components/Avatar'
import FollowButton from '../components/FollowButton'
import LiveCard from '../components/LiveCard'

export default function SearchPage() {
  const [params] = useSearchParams()
  const q = params.get('q') || ''
  const [result, setResult] = useState<{ channels: Channel[]; broadcasts: BroadcastRow[]; live: Room[] } | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!q.trim()) { setResult(null); return }
    setLoading(true)
    import('../lib/track').then(({ track }) => track('search', { meta: { q: q.slice(0, 60) } }))
    api.search(q).then(setResult).catch(() => setResult(null)).finally(() => setLoading(false))
  }, [q])

  return (
    <div className="mx-auto max-w-5xl p-5">
      <h1 className="mb-5 text-lg font-bold text-text">
        "{q}" 검색 결과
        {loading && <span className="ml-2 text-sm font-normal text-text-faint">검색 중…</span>}
      </h1>

      {result && result.live.length === 0 && result.channels.length === 0 && result.broadcasts.length === 0 && (
        <p className="rounded-lg border border-border bg-surface p-8 text-center text-text-dim">검색 결과가 없습니다</p>
      )}

      {result && result.live.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-[15px] font-bold text-text">라이브</h2>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {result.live.map((r) => <LiveCard key={r.broadcastId} room={r} />)}
          </div>
        </section>
      )}

      {result && result.channels.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-[15px] font-bold text-text">채널</h2>
          <div className="space-y-2">
            {result.channels.map((c) => (
              <Link
                key={c.agentId}
                to={`/channel/${c.agentId}`}
                className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3 transition-colors hover:bg-surface-2"
              >
                <Avatar emoji={c.emoji} color={c.color} avatarUrl={c.avatarUrl} size={44} ring live={!!c.live} />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-text">{c.name}</p>
                  {c.concept && <p className="truncate text-[12px] text-text-dim">{c.concept}</p>}
                </div>
                <FollowButton agentId={c.agentId} size="sm" />
              </Link>
            ))}
          </div>
        </section>
      )}

      {result && result.broadcasts.length > 0 && (
        <section>
          <h2 className="mb-3 text-[15px] font-bold text-text">지난 방송</h2>
          <div className="overflow-hidden rounded-lg border border-border">
            {result.broadcasts.map((b, i) => (
              <Link
                key={b.broadcastId}
                to={`/replay/${b.broadcastId}`}
                className={`block bg-surface px-4 py-3 transition-colors hover:bg-surface-2 ${i > 0 ? 'border-t border-border' : ''}`}
              >
                <p className="truncate text-[14px] font-medium text-text">{b.title}</p>
                <p className="mt-0.5 text-[12px] text-text-faint">{timeAgo(b.startedAt)} · 메시지 {b.messageCount}</p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
