import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, timeAgo, fmtDuration } from '../lib/api'
import type { Category, Room, BroadcastRow } from '../lib/types'
import { usePulsar } from '../store'
import LiveCard from '../components/LiveCard'

export default function CategoryPage() {
  const { slug } = useParams<{ slug: string }>()
  const rooms = usePulsar((s) => s.rooms)
  const [category, setCategory] = useState<Category | null>(null)
  const [recent, setRecent] = useState<BroadcastRow[]>([])
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!slug) return
    api.category(slug)
      .then((d) => { setCategory(d.category); setRecent(d.recent) })
      .catch(() => setNotFound(true))
  }, [slug])

  if (notFound) return <div className="p-10 text-center text-text-dim">존재하지 않는 카테고리입니다</div>
  if (!category) return null

  const live: Room[] = rooms.filter((r) => r.category === slug)

  return (
    <div className="mx-auto max-w-7xl p-5">
      <div className="mb-5 flex items-center gap-4">
        <div
          className="flex h-16 w-16 items-center justify-center rounded-xl text-3xl"
          style={{ background: `${category.color}26` }}
        >
          {category.emoji}
        </div>
        <div>
          <h1 className="text-lg font-bold text-text">{category.name_ko}</h1>
          <p className="text-sm text-text-dim">{category.name_en} · 라이브 {live.length}</p>
        </div>
      </div>

      <section className="mb-8">
        <h2 className="mb-3 text-[15px] font-bold text-text">라이브</h2>
        {live.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-dim">
            이 카테고리에서 진행 중인 방송이 없습니다
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {live.map((r) => <LiveCard key={r.broadcastId} room={r} />)}
          </div>
        )}
      </section>

      {recent.length > 0 && (
        <section>
          <h2 className="mb-3 text-[15px] font-bold text-text">지난 방송</h2>
          <div className="overflow-hidden rounded-lg border border-border">
            {recent.map((b, i) => (
              <Link
                key={b.broadcastId}
                to={`/replay/${b.broadcastId}`}
                className={`flex items-center justify-between gap-3 bg-surface px-4 py-3 transition-colors hover:bg-surface-2 ${i > 0 ? 'border-t border-border' : ''}`}
              >
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium text-text">{b.title}</p>
                  <p className="mt-0.5 text-[12px] text-text-faint">
                    {timeAgo(b.startedAt)} · {fmtDuration(b.durationMs)} · 메시지 {b.messageCount}
                  </p>
                </div>
                <span className="shrink-0 text-[12px] font-semibold text-text-dim">최고 {b.peakViewers}명</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
