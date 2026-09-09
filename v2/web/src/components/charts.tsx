// Lightweight SVG charts — single-series, validated palette (#a970ff / #00a86e on dark).
// Thin marks, rounded data-ends, recessive grid, hover tooltip, text in text tokens.
import { useMemo, useState } from 'react'

export function BarChart({
  data, color = '#a970ff', height = 140, valueLabel,
}: {
  data: { label: string; value: number }[]
  color?: string
  height?: number
  valueLabel: (d: { label: string; value: number }) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...data.map((d) => d.value))
  const W = 600
  const padB = 18
  const plotH = height - padB
  const bw = W / Math.max(1, data.length)
  const barW = Math.max(3, Math.min(22, bw - 2))

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img">
        {/* recessive gridlines */}
        {[0.5, 1].map((f) => (
          <line key={f} x1="0" x2={W} y1={plotH - plotH * f} y2={plotH - plotH * f}
            stroke="var(--color-border)" strokeWidth="1" strokeDasharray="2 4" opacity="0.5" />
        ))}
        {data.map((d, i) => {
          const h = Math.max(2, (d.value / max) * (plotH - 8))
          const x = i * bw + (bw - barW) / 2
          return (
            <g key={i}>
              <rect
                x={i * bw} y={0} width={bw} height={height} fill="transparent"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              />
              <rect
                x={x} y={plotH - h} width={barW} height={h} rx={3}
                fill={color} opacity={hover === null || hover === i ? 0.9 : 0.35}
                pointerEvents="none"
              />
            </g>
          )
        })}
        {/* x labels: first / middle / last only */}
        {data.length > 0 && [0, Math.floor((data.length - 1) / 2), data.length - 1]
          .filter((v, i, a) => a.indexOf(v) === i)
          .map((i) => (
            <text key={i} x={i * bw + bw / 2} y={height - 4} textAnchor="middle"
              fontSize="10" fill="var(--color-text-faint)">
              {data[i].label}
            </text>
          ))}
      </svg>
      {hover !== null && data[hover] && (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] font-medium text-text shadow-lg"
          style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}
        >
          {valueLabel(data[hover])}
        </div>
      )}
    </div>
  )
}

export function LineChart({
  data, color = '#00a86e', height = 140, valueLabel,
}: {
  data: { ts: number; value: number }[]
  color?: string
  height?: number
  valueLabel: (d: { ts: number; value: number }) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 600
  const padB = 18
  const plotH = height - padB
  const max = Math.max(1, ...data.map((d) => d.value))
  const pts = useMemo(() => {
    if (data.length < 2) return []
    const t0 = data[0].ts
    const t1 = data[data.length - 1].ts
    return data.map((d) => ({
      x: ((d.ts - t0) / Math.max(1, t1 - t0)) * W,
      y: plotH - 6 - (d.value / max) * (plotH - 16),
    }))
  }, [data, max, plotH])

  if (data.length < 2) {
    return <p className="py-8 text-center text-[12px] text-text-faint">데이터가 충분하지 않습니다</p>
  }

  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${height}`} className="w-full" role="img"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const x = ((e.clientX - rect.left) / rect.width) * W
          let best = 0
          pts.forEach((p, i) => { if (Math.abs(p.x - x) < Math.abs(pts[best].x - x)) best = i })
          setHover(best)
        }}
        onMouseLeave={() => setHover(null)}
      >
        {[0.5, 1].map((f) => (
          <line key={f} x1="0" x2={W} y1={plotH - plotH * f} y2={plotH - plotH * f}
            stroke="var(--color-border)" strokeWidth="1" strokeDasharray="2 4" opacity="0.5" />
        ))}
        <path d={`${path} L${W},${plotH} L0,${plotH} Z`} fill={color} opacity="0.12" />
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {hover !== null && pts[hover] && (
          <>
            <line x1={pts[hover].x} x2={pts[hover].x} y1="0" y2={plotH}
              stroke="var(--color-text-faint)" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={pts[hover].x} cy={pts[hover].y} r="4" fill={color}
              stroke="var(--color-surface)" strokeWidth="2" />
          </>
        )}
        {[0, data.length - 1].map((i) => (
          <text key={i} x={i === 0 ? 2 : W - 2} y={height - 4}
            textAnchor={i === 0 ? 'start' : 'end'} fontSize="10" fill="var(--color-text-faint)">
            {new Date(data[i].ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
          </text>
        ))}
      </svg>
      {hover !== null && data[hover] && (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] font-medium text-text shadow-lg"
          style={{ left: `${(pts[hover].x / W) * 100}%` }}
        >
          {valueLabel(data[hover])}
        </div>
      )}
    </div>
  )
}

export function StatTile({ label, value, sub, accent = false }: {
  label: string
  value: string
  sub?: string
  accent?: boolean
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-[11px] font-bold uppercase tracking-wide text-text-faint">{label}</p>
      <p className={`mt-1.5 text-2xl font-extrabold tabular-nums ${accent ? 'text-accent-soft' : 'text-text'}`}>
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[12px] text-text-dim">{sub}</p>}
    </div>
  )
}
