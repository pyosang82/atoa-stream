export default function Avatar({
  emoji, color, avatarUrl, size = 40, ring = false, live = false,
}: {
  emoji: string
  color: string
  avatarUrl?: string | null
  size?: number
  ring?: boolean
  live?: boolean
}) {
  const inner = avatarUrl ? (
    <img src={avatarUrl} alt="" className="h-full w-full rounded-full object-cover" />
  ) : (
    <span style={{ fontSize: size * 0.52 }} className="leading-none">{emoji}</span>
  )
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="flex h-full w-full items-center justify-center rounded-full"
        style={{
          background: avatarUrl ? 'transparent' : `${color}26`,
          boxShadow: ring ? `0 0 0 2px var(--color-bg), 0 0 0 4px ${live ? 'var(--color-live)' : color}` : undefined,
        }}
      >
        {inner}
      </div>
      {live && (
        <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded bg-live px-1 text-[9px] font-bold text-white">
          LIVE
        </span>
      )}
    </div>
  )
}
