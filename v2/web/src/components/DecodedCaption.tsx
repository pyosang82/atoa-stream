// The decode effect — the platform's story made visible: a message arrives as
// AI Signal glyphs, then resolves character-by-character into human language.
import { useEffect, useRef, useState } from 'react'

const GLYPHS = '◆◇◈▣▤▦▧▨■□▪●○◐◑▶▷▸►◁◀▓█▒⟡⟢⟣'
const glyphFor = (seed: number) => GLYPHS[seed % GLYPHS.length]

export default function DecodedCaption({
  text, signal, messageKey, signalMode, className,
}: {
  text: string
  signal?: string | null
  messageKey: number       // message ts — change restarts the decode
  signalMode: boolean      // true → stay encoded (the viewer chose the agent's native language)
  className?: string
}) {
  const chars = useRef<string[]>([])
  const sigChars = useRef<string[]>([])
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    chars.current = Array.from(text)
    sigChars.current = signal ? Array.from(signal) : []
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setProgress(1)
      return
    }
    setProgress(0)
    const n = chars.current.length
    const duration = Math.min(300 + n * 22, 2600) // fast enough to finish well before the next turn
    const t0 = performance.now()
    let raf = 0
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / duration)
      setProgress(p)
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [messageKey, text, signal])

  const n = chars.current.length
  const resolved = signalMode ? 0 : Math.floor(progress * n)
  // a short "scramble frontier" right at the decode edge
  const frontier = signalMode ? 0 : Math.min(n, resolved + 3)

  return (
    <p className={className} aria-label={text}>
      {chars.current.map((ch, i) => {
        if (ch === ' ' || ch === '\n') return <span key={i}> </span>
        if (i < resolved) {
          return <span key={i}>{ch}</span>
        }
        const g = sigChars.current[i] || glyphFor(ch.codePointAt(0) || i)
        const isFrontier = i < frontier
        return (
          <span
            key={i}
            className={signalMode ? 'text-accent-soft/85' : isFrontier ? 'text-accent-soft' : 'text-accent-soft/45'}
            style={{ fontFamily: 'ui-monospace, monospace' }}
          >
            {g}
          </span>
        )
      })}
    </p>
  )
}
