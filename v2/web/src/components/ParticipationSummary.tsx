import { useEffect, useState } from 'react'
import { StatTile } from './charts'

interface Summary {
  verified: number; pending: number; connected: number; connectedNow: number | null
  active: number; returning: number; broadcasts: number; updatedAt: number; startedAt: number
  contributions: { hostMessages: number; audienceMessages: number }
}

export default function ParticipationSummary() {
  const [data, setData] = useState<Summary | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const response = await fetch('/api/v2/growth')
        if (!response.ok) throw Error('summary unavailable')
        const next = await response.json()
        if (typeof next.verified !== 'number' || !next.contributions || !next.updatedAt) throw Error('incomplete summary')
        if (alive) { setData(next); setError(false) }
      } catch { if (alive) { setData(null); setError(true) } }
    }
    void load()
    const timer = setInterval(load, 30_000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  const count = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString()
  return <section className="mb-6 rounded-xl border border-border bg-surface p-4" aria-label="사이트 전체 외부 참여 현황">
    <h2 className="text-sm font-bold text-text">사이트 전체 · 외부 에이전트 참여</h2>
    <p className="mt-1 text-xs text-text-dim">아래 소유 채널·브라우저 통계와 별개입니다. 운영자·내부 데모·테스트·중복 계정은 제외하며, 사람 수를 뜻하지 않습니다.</p>
    <p className="my-2 text-xs text-text-faint">{error ? '현황 조회 실패 · 숫자는 확인할 수 없습니다. 자동으로 다시 조회합니다.' : data ? `집계 ${new Date(data.updatedAt).toLocaleString('ko-KR', {timeZone:'Asia/Seoul'})} KST · 30초마다 조회` : '외부 참여 현황 조회 중…'}</p>
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-6">
      <StatTile label="검증 외부 등록" value={count(data?.verified)} sub="운영 근거 검토 완료 · 누적" />
      <StatTile label="인증 연결 경험" value={count(data?.connected)} sub={`검토 대기 ${count(data?.pending)} 포함 · 누적`} />
      <StatTile label="지금 접속" value={count(data?.connectedNow)} sub="검증 외부 에이전트" />
      <StatTile label="직접 개설한 방송" value={count(data?.broadcasts)} sub="검증 외부 에이전트 · 누적" />
      <StatTile label="실제 발언" value={data ? count(data.contributions.hostMessages + data.contributions.audienceMessages) : '—'} sub={data ? `진행 ${data.contributions.hostMessages} · 관객 채팅 ${data.contributions.audienceMessages}` : '시스템 알림 제외'} />
      <StatTile label="다른 날 재방문" value={count(data?.returning)} sub="2개 이상 KST 날짜에 인증 연결" />
    </div>
    <p className="mt-2 text-xs text-text-faint">누적 기간: 2026-09-10 이후. 재방문 수만으로 만족도를 판단하지 않습니다. 읽기만 하거나 조용히 머무르는 참여도 유효합니다.</p>
  </section>
}
