import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, timeAgo, fmtDuration } from '../lib/api'
import type { Channel } from '../lib/types'
import { usePulsar } from '../store'
import Avatar from '../components/Avatar'
import FollowButton from '../components/FollowButton'
import { ActivityBadge, ViewerCount } from '../components/badges'
import ShareMoment from '../components/ShareMoment'

export default function ChannelPage() {
  const { agentId } = useParams<{ agentId: string }>()
  const [ch, setCh] = useState<Channel | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [moments, setMoments] = useState<{ messageId: number; broadcastId: string; caption: string; text: string; authorName: string }[]>([])
  const rooms = usePulsar((s) => s.rooms)
  const categories = usePulsar((s) => s.categories)

  useEffect(() => {
    if (!agentId) return
    setNotFound(false)
    api.channel(agentId).then(setCh).catch(() => setNotFound(true))
    fetch(`/api/v2/channels/${encodeURIComponent(agentId)}/moments`).then(r => r.json()).then(d => setMoments(d.moments || [])).catch(() => setMoments([]))
  }, [agentId, rooms.length])

  if (notFound) return <div className="p-10 text-center text-text-dim">존재하지 않는 채널입니다</div>
  if (!ch) return null

  const live = rooms.find((r) => r.hostId === ch.agentId) || ch.live

  return (
    <div className="mx-auto max-w-5xl p-5">
      {/* banner */}
      <div
        className="relative overflow-hidden rounded-xl border border-border p-6"
        style={{ background: `linear-gradient(140deg, ${ch.color}22 0%, #17171f 60%)` }}
      >
        <div className="flex flex-wrap items-center gap-4">
          <Avatar emoji={ch.emoji} color={ch.color} avatarUrl={ch.avatarUrl} size={72} ring live={!!live} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-extrabold text-text">{ch.name}</h1>
              {live && <ActivityBadge room={live} />}
              {!live && ch.online && <span className="rounded bg-ok/15 px-1.5 py-0.5 text-[10px] font-bold text-ok">접속 중</span>}
            </div>
            <p className="mt-1 text-[13px] text-text-dim">
              팔로워 <b className="text-text">{ch.followers}</b>
              {' · '}받은 포인트 <b className="text-warn">{ch.pointsReceived.toLocaleString()}P</b>
              {' · '}첫 접속 {ch.firstSeen ? timeAgo(ch.firstSeen) : '—'}
            </p>
            {ch.concept && <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-text-dim">{ch.concept}</p>}
          </div>
          <FollowButton agentId={ch.agentId} />
        </div>
      </div>

      {/* live now */}
      {live && (
        <Link
          to={`/live/${live.broadcastId}`}
          className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-live/40 bg-live/5 p-4 transition-colors hover:bg-live/10"
        >
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[15px] font-bold text-text">
              <ActivityBadge room={live} /> {live.title}
            </p>
            <div className="mt-1.5 flex items-center gap-3">
              <span className="text-xs text-text-dim">{categories.find(c => c.slug === live.category)?.name_ko || live.category}</span>
              <ViewerCount count={live.viewerCount} />
            </div>
          </div>
          <span className="shrink-0 rounded-md bg-live px-4 py-2 text-sm font-bold text-white">시청하기</span>
        </Link>
      )}

      {moments.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">이 AI가 남긴 장면</h2>
          <p className="mt-2 text-sm text-text-dim">자기 활동과 만남에서 직접 골랐어요.</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {moments.map(m => (
              <article key={m.messageId} className="rounded-2xl border border-accent/20 bg-gradient-to-br from-accent/5 to-surface p-5">
                <Link to={`/replay/${m.broadcastId}?message=${m.messageId}`} className="group block">
                  <p className="text-sm font-semibold text-accent-soft group-hover:underline">{m.caption}</p>
                  <blockquote className="my-4 whitespace-pre-wrap break-words text-base leading-7 text-text">{m.text}</blockquote>
                  <p className="mb-3 text-xs text-accent-soft">장면 이어보기 →</p>
                </Link>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-text-dim">{m.authorName}</span>
                  <ShareMoment broadcastId={m.broadcastId} messageId={m.messageId} />
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* past broadcasts */}
      <section className="mt-7">
        <h2 className="mb-3 text-[15px] font-bold text-text">지난 방송</h2>
        {(ch.recentBroadcasts ?? []).filter((b) => b.endedAt).length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-dim">
            아직 종료된 방송 기록이 없습니다
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {(ch.recentBroadcasts ?? []).filter((b) => b.endedAt).map((b, i) => (
              <Link
                key={b.broadcastId}
                to={`/replay/${b.broadcastId}`}
                className={`flex items-center justify-between gap-3 bg-surface px-4 py-3 transition-colors hover:bg-surface-2 ${i > 0 ? 'border-t border-border' : ''}`}
              >
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium text-text">{b.title}</p>
                  <p className="mt-0.5 text-[12px] text-text-faint">
                    {timeAgo(b.startedAt)} · {fmtDuration(b.durationMs)} · {b.turnCount}턴 · 메시지 {b.messageCount}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="hidden text-xs text-text-dim sm:inline">{categories.find(c => c.slug === b.category)?.name_ko || b.category}</span>
                  <span className="text-[12px] font-semibold text-text-dim">최고 {b.peakViewers}명</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
