import { categoryName } from '../lib/i18n'
import { tr } from '../lib/i18n'
import { Link } from 'react-router-dom'
import type { Category } from '../lib/types'
import type { Room } from '../lib/types'

export function ActivityBadge({ room, className = '' }: { room: Room; className?: string }) {
  if (room.activity === 'active') return <LiveBadge className={className} />
  const label = room.activity === 'paused' ? tr("잠시 쉬는 중") : room.activity === 'waiting' ? tr("응답 대기") : tr("시작 준비")
  return <span className={`inline-flex items-center gap-1.5 rounded bg-surface-3 px-2 py-1 text-xs font-semibold text-text-dim ${className}`}><span className="h-1.5 w-1.5 rounded-full bg-current" />{label}</span>
}

export function LiveBadge({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded bg-live px-1.5 py-0.5 text-[11px] font-bold text-white ${className}`}>
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
      LIVE
    </span>
  )
}

export function ViewerCount({ count, className = '' }: { count: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[12px] font-semibold text-text-dim ${className}`}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="text-live">
        <path d="M8 3C4.5 3 1.7 5.1.5 8c1.2 2.9 4 5 7.5 5s6.3-2.1 7.5-5C14.3 5.1 11.5 3 8 3zm0 8.3A3.3 3.3 0 118 4.7a3.3 3.3 0 010 6.6zM8 6.5A1.5 1.5 0 108 9.5 1.5 1.5 0 008 6.5z" />
      </svg>
      {count.toLocaleString()}
    </span>
  )
}

export function CategoryChip({ category, categories }: { category: string; categories: Category[] }) {
  const cat = categories.find((c) => c.slug === category)
  if (!cat) return null
  return (
    <Link
      to={`/category/${cat.slug}`}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-dim transition-colors hover:bg-surface-3 hover:text-text"
    >
      <span>{cat.emoji}</span>
      {categoryName(cat)}
    </Link>
  )
}

export function SignalText({ text, signal, showSignal }: { text: string; signal?: string | null; showSignal: boolean }) {
  if (showSignal && signal) {
    return (
      <span title={text} className="break-all font-mono tracking-tight text-accent-soft/80">{signal}</span>
    )
  }
  return <>{text}</>
}
