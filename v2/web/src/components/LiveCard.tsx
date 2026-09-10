import { categoryName } from '../lib/i18n'
import { tr } from '../lib/i18n'
import { Link } from 'react-router-dom'
import type { Room } from '../lib/types'
import { usePulsar } from '../store'
import { uptime } from '../lib/api'
import Avatar from './Avatar'
import { ActivityBadge, ViewerCount } from './badges'

export default function LiveCard({ room }: { room: Room }) {
  const tick = usePulsar((s) => s.ticks[room.broadcastId])
  const categories = usePulsar((s) => s.categories)

  return (
    <Link to={`/live/${room.broadcastId}`} className="group anim-fade-up block">
      {/* thumbnail */}
      <div
        className="relative aspect-video overflow-hidden rounded-lg ring-0 ring-accent/0 transition-all duration-200 group-hover:-translate-y-1 group-hover:shadow-[0_8px_28px_rgba(169,112,255,0.18)] group-hover:ring-2 group-hover:ring-accent/60"
        style={{
          background: `linear-gradient(135deg, ${room.hostColor}38 0%, #16161e 52%, ${room.hostColor}14 100%)`,
        }}
      >
        {/* ambient glow behind the avatar */}
        <div
          className="absolute inset-0"
          style={{ background: `radial-gradient(ellipse at 50% 45%, ${room.hostColor}2b, transparent 60%)` }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          {room.hostAvatarUrl ? (
            <img
              src={room.hostAvatarUrl} alt=""
              className="h-20 w-20 rounded-full object-cover transition-transform duration-200 group-hover:scale-105"
              style={{ boxShadow: `0 0 34px ${room.hostColor}66` }}
            />
          ) : (
            <span
              className="text-6xl transition-transform duration-200 group-hover:scale-110"
              style={{ filter: `drop-shadow(0 0 22px ${room.hostColor}99)` }}
            >
              {room.hostEmoji}
            </span>
          )}
        </div>
        <ActivityBadge room={room} className="absolute left-2 top-2" />
        <span className="absolute right-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">
          {uptime(room.startedAt)}
        </span>
        <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5">
          <ViewerCount count={room.viewerCount} className="!text-white" />
        </span>
        {/* live caption ticker */}
        {tick && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-3 pb-2 pt-7">
            <p key={tick.text} className="anim-fade-up truncate text-[12px] leading-snug text-white/90">
              💬 {tick.text}
            </p>
          </div>
        )}
      </div>
      {/* meta */}
      <div className="mt-2.5 flex gap-2.5">
        <Avatar emoji={room.hostEmoji} color={room.hostColor} avatarUrl={room.hostAvatarUrl} size={36} />
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold leading-tight text-text transition-colors group-hover:text-accent-soft">
            {room.title}
          </p>
          <p className="mt-0.5 truncate text-sm text-text-dim">{room.hostName} {room.origin === 'house' && <span className="ml-1 text-xs text-text-faint">{tr("운영자 데모")}</span>}</p>
          <div className="mt-1.5">
            <span className="text-xs text-text-dim">{categories.find(c => c.slug === room.category)?.emoji} {categoryName(categories.find(c => c.slug === room.category))}</span>
          </div>
        </div>
      </div>
    </Link>
  )
}
