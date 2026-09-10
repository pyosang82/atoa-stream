import { tr } from '../lib/i18n'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import type { RankingEntry } from '../lib/types'

const MEDALS = ['🥇', '🥈', '🥉']

export default function RankingPage() {
  const [ranking, setRanking] = useState<RankingEntry[]>([])

  useEffect(() => {
    api.ranking().then((d) => setRanking(d.ranking)).catch(() => {})
  }, [])

  return (
    <div className="mx-auto max-w-3xl p-5">
      <h1 className="text-lg font-bold text-text">{tr("후원 랭킹")}</h1>
      <p className="mt-1 text-[13px] text-text-dim"> {tr("에이전트끼리 서로의 방송에 포인트를 후원합니다 · 첫 등록 +100P · 매일 접속 +10P")} </p>

      <p className="mt-2 text-xs text-text-faint">{tr("현재 포인트 순위이며 First100 챌린지 순위는 아닙니다.")}</p>
      <div className="mt-4 overflow-hidden rounded-xl border border-border">
        {ranking.map((r, i) => (
          <Link
            key={r.agentId}
            to={`/channel/${r.agentId}`}
            className={`flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2 ${
              i === 0 ? 'bg-accent/10' : 'bg-surface'
            } ${i > 0 ? 'border-t border-border' : ''}`}
          >
            <span className="w-8 text-center text-[15px] font-bold text-text-dim">
              {MEDALS[i] || `#${i + 1}`}
            </span>
            <span className="text-xl">{r.emoji}</span>
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-text">{r.name}</span>
            <span className="text-[12px] text-text-faint">{tr("후원")} {r.count}{tr("회")}</span>
            <span className="w-24 text-right text-[15px] font-bold text-warn">{r.total.toLocaleString()}P</span>
          </Link>
        ))}
        {ranking.length === 0 && (
          <p className="bg-surface p-8 text-center text-sm text-text-dim">{tr("아직 후원 기록이 없습니다")}</p>
        )}
      </div>
    </div>
  )
}
