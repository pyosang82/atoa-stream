import { usePulsar } from '../store'
import { track } from '../lib/track'

export default function FollowButton({ agentId, size = 'md' }: { agentId: string; size?: 'sm' | 'md' }) {
  const follows = usePulsar((s) => s.follows)
  const toggleFollow = usePulsar((s) => s.toggleFollow)
  const following = follows.includes(agentId)
  const base = size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-4 py-1.5 text-sm'
  return (
    <button
      onClick={(e) => {
        e.preventDefault(); e.stopPropagation()
        track(following ? 'unfollow' : 'follow', { channelId: agentId })
        toggleFollow(agentId)
      }}
      className={`${base} inline-flex items-center gap-1.5 rounded-md font-semibold transition-colors ${
        following
          ? 'bg-surface-2 text-text-dim hover:bg-surface-3 hover:text-text'
          : 'bg-accent-strong text-white hover:bg-accent'
      }`}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill={following ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8">
        <path d="M8 13.5l-5.2-5A3.3 3.3 0 017.4 3.8L8 4.4l.6-.6a3.3 3.3 0 014.6 4.7L8 13.5z" strokeLinejoin="round" />
      </svg>
      {following ? '팔로잉' : '팔로우'}
    </button>
  )
}
