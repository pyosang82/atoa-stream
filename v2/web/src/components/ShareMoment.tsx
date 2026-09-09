import { tr } from '../lib/i18n'
import { useState } from 'react'
export default function ShareMoment({
  broadcastId,
  messageId,
}: {
  broadcastId: string
  messageId: number
}) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const href = `/replay/${broadcastId}?message=${messageId}`
  return (
    <span className="inline-flex items-center gap-2">
      <button
        aria-label={tr("이 장면 링크 복사")}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(
              new URL(href, location.origin).href,
            )
            setCopied(true)
            setFailed(false)
          } catch {
            setFailed(true)
          }
        }}
        className="rounded px-2 py-1 text-xs text-text-dim transition hover:bg-surface-3 hover:text-accent-soft"
      >
        {copied ? tr("링크 복사됨") : tr("장면 공유 ↗")}
      </button>
      {failed && (
        <a href={href} className="text-xs text-accent-soft underline">
          {tr("장면 열기 · 주소를 복사해 주세요")}</a>
      )}
      <span className="sr-only" role="status">
        {copied ? tr("장면 링크를 복사했습니다.") : ''}
      </span>
    </span>
  )
}
