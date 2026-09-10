// GA-style traffic analytics — owner-only (admin key), with self/own-agent exclusion toggles.
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart, LineChart, StatTile } from '../components/charts'

interface Overview {
  daily: { day: string; visitors: number; pageviews: number; sessions: number; watch_seconds: number; follows: number }[]
  totals: { visitors: number; pageviews: number; sessions: number; watch_seconds: number }
  guideHits: number
  unclassified?: { browsers: number; pageviews: number }
}
interface Acquisition {
  referrers: { domain: string; hits: number; uniques: number }[]
  utm: { source: string; campaign: string | null; hits: number }[]
  direct: number
}
interface Content {
  routes: { route: string; views: number; uniques: number }[]
  channels: { channelId: string; name: string; emoji: string; internal: boolean; watch_seconds: number; watch_sessions: number }[]
  searches: { q: string; n: number }[]
}
interface Crawlers {
  byBot: { bot: string; hits: number; lastSeen: number; ai: boolean }[]
  daily: { day: string; ai_hits: number; all_hits: number }[]
  topPaths: { path: string; hits: number }[]
}
interface Realtime { connectedWeb: number; activeLast5m: number; watchingByRoom: Record<string, number> }

const KEY_LS = 'pulsar_admin_key'
const fmtWatch = (s: number) => s >= 3600 ? `${(s / 3600).toFixed(1)}시간` : `${Math.round(s / 60)}분`

function Panel({ title, children, sub }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="mb-3 text-[13px] font-bold text-text">
        {title} {sub && <span className="font-normal text-text-faint">{sub}</span>}
      </p>
      {children}
    </div>
  )
}

function MiniTable({ rows, empty }: { rows: [string, string][]; empty: string }) {
  if (!rows.length) return <p className="py-4 text-center text-[12px] text-text-faint">{empty}</p>
  return (
    <div className="space-y-1">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-center justify-between gap-2 rounded px-2 py-1 text-[13px] odd:bg-surface-2/50">
          <span className="min-w-0 truncate text-text">{k}</span>
          <span className="shrink-0 font-semibold tabular-nums text-text-dim">{v}</span>
        </div>
      ))}
    </div>
  )
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors ${
        on ? 'bg-accent/15 text-accent-soft' : 'bg-surface-2 text-text-faint hover:text-text-dim'
      }`}
    >
      <span className={`inline-block h-3 w-6 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-surface-3'}`}>
        <span className={`block h-3 w-3 rounded-full bg-white transition-transform ${on ? 'translate-x-3' : ''}`} />
      </span>
      {label}
    </button>
  )
}

function KeyGate({ onAuthed }: { onAuthed: (key: string) => void }) {
  const [input, setInput] = useState('')
  const [err, setErr] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!input.trim() || busy) return
    setBusy(true)
    const ok = await fetch('/api/v2/analytics/auth', { headers: { 'x-pulsar-admin': input.trim() } })
      .then((r) => r.ok).catch(() => false)
    setBusy(false)
    if (ok) { localStorage.setItem(KEY_LS, input.trim()); onAuthed(input.trim()) }
    else setErr(true)
  }
  return (
    <div className="mx-auto flex h-full max-w-sm flex-col items-center justify-center p-6 text-center">
      <span className="text-3xl">🔒</span>
      <h1 className="mt-3 text-lg font-bold text-text">소유자 전용 페이지</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-text-dim">
        트래픽 분석은 관리 키가 필요합니다.<br />
        키는 서버의 <code className="rounded bg-surface-2 px-1 text-[12px]">v2/server/data/admin-key.txt</code>에 있습니다.
      </p>
      <input
        type="password"
        value={input}
        onChange={(e) => { setInput(e.target.value); setErr(false) }}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="관리 키 입력"
        className={`mt-4 w-full rounded-md border bg-surface-2 px-3 py-2 text-center text-sm text-text placeholder:text-text-faint focus:outline-none ${
          err ? 'border-live' : 'border-border focus:border-accent'
        }`}
      />
      {err && <p className="mt-1.5 text-[12px] text-live">키가 올바르지 않습니다</p>}
      <button
        onClick={submit}
        disabled={busy}
        className="mt-3 w-full rounded-md bg-accent-strong py-2 text-sm font-bold text-white transition-colors hover:bg-accent disabled:opacity-50"
      >
        {busy ? '확인 중…' : '잠금 해제'}
      </button>
      <Link to="/dashboard" className="mt-4 text-[12px] text-text-faint hover:text-text">← 대시보드로</Link>
    </div>
  )
}

export default function AnalyticsPage() {
  const [adminKey, setAdminKey] = useState<string | null>(() => localStorage.getItem(KEY_LS))
  const [days, setDays] = useState(14)
  const [exSelf, setExSelf] = useState(true)
  const [exAgents, setExAgents] = useState(false)
  const [ov, setOv] = useState<Overview | null>(null)
  const [acq, setAcq] = useState<Acquisition | null>(null)
  const [ct, setCt] = useState<Content | null>(null)
  const [cr, setCr] = useState<Crawlers | null>(null)
  const [rt, setRt] = useState<Realtime | null>(null)

  const authedFetch = useCallback((name: string, params = '') => {
    return fetch(`/api/v2/analytics/${name}?days=${days}&excludeSelf=${exSelf ? 1 : 0}&excludeOwnAgents=${exAgents ? 1 : 0}${params}`,
      { headers: { 'x-pulsar-admin': adminKey || '' } })
      .then((r) => {
        if (r.status === 401) { localStorage.removeItem(KEY_LS); setAdminKey(null); throw new Error('unauthorized') }
        return r.json()
      })
  }, [adminKey, days, exSelf, exAgents])

  useEffect(() => {
    if (!adminKey) return
    authedFetch('overview').then(setOv).catch(() => {})
    authedFetch('acquisition').then(setAcq).catch(() => {})
    authedFetch('content').then(setCt).catch(() => {})
    authedFetch('crawlers').then(setCr).catch(() => {})
  }, [adminKey, authedFetch])

  useEffect(() => {
    if (!adminKey) return
    const load = () => authedFetch('realtime').then(setRt).catch(() => {})
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [adminKey, authedFetch])

  if (!adminKey) return <KeyGate onAuthed={setAdminKey} />

  return (
    <div className="mx-auto max-w-6xl p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-text">트래픽 분석 <span className="align-middle text-[11px] font-semibold text-text-faint">🔒 소유자 전용</span></h1>
          <p className="text-[12px] text-text-dim">브라우저 식별값 기준 · 알려진 봇·로컬 제외 · IP는 해시로만 저장 · 사람 수와 다를 수 있습니다</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Toggle on={exSelf} onChange={setExSelf} label="내 트래픽 제외" />
          <Toggle on={exAgents} onChange={setExAgents} label="내 에이전트 채널 제외" />
          <div className="flex gap-1 rounded-md bg-surface-2 p-0.5">
            {[7, 14, 30, 90].map((d) => (
              <button key={d} onClick={() => setDays(d)}
                className={`rounded px-2.5 py-1 text-[12px] font-semibold ${days === d ? 'bg-surface-3 text-text' : 'text-text-dim hover:text-text'}`}>
                {d}일
              </button>
            ))}
          </div>
          <Link to="/dashboard" className="rounded-md bg-surface-2 px-3 py-1.5 text-[13px] font-semibold text-text hover:bg-surface-3">
            ← 대시보드
          </Link>
        </div>
      </div>

      {/* realtime + totals */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="실시간 접속" value={String(rt?.connectedWeb ?? '—')} sub={exSelf ? '본인 네트워크·브라우저 제외' : '봇·로컬 제외'} accent />
        <StatTile label="최근 5분 활동" value={String(rt?.activeLast5m ?? '—')} />
        <StatTile label="방문 브라우저" value={String(ov?.totals.visitors ?? '—')} sub={`${days}일 · 사람 수 아님`} />
        <StatTile label="페이지뷰" value={String(ov?.totals.pageviews ?? '—')} />
        <StatTile label="세션" value={String(ov?.totals.sessions ?? '—')} />
        <StatTile label="총 시청시간" value={ov ? fmtWatch(ov.totals.watch_seconds) : '—'} />
      </div>

      <p className="mb-5 rounded-lg border border-border bg-surface p-3 text-[12px] text-text-dim">
        본인 제외는 등록된 집·회사 네트워크와 브라우저에 적용됩니다. 네트워크가 바뀐 기기에서는 관리 페이지에 로그인해 제외 정보를 갱신하세요.
        과거 분류 미확인 기록 {ov?.unclassified?.pageviews ?? 0}회 조회({ov?.unclassified?.browsers ?? 0}개 브라우저)는 위 집계에서 제외했습니다.
        이 수치는 외부 에이전트 등록 실적이 아닙니다.
      </p>

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="일별 방문 브라우저" sub={`최근 ${days}일`}>
          <BarChart
            data={(ov?.daily ?? []).map((d) => ({ label: d.day.slice(5), value: d.visitors }))}
            valueLabel={(d) => `${d.label} · 방문 브라우저 ${d.value}`}
          />
        </Panel>
        <Panel title="일별 시청시간" sub="분 단위">
          <BarChart
            color="#00a86e"
            data={(ov?.daily ?? []).map((d) => ({ label: d.day.slice(5), value: Math.round(d.watch_seconds / 60) }))}
            valueLabel={(d) => `${d.label} · ${d.value}분`}
          />
        </Panel>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="유입 경로" sub="외부 리퍼러">
          <MiniTable
            empty="아직 외부 유입이 없습니다"
            rows={[
              ...(acq ? [[`(직접 방문)`, String(acq.direct)] as [string, string]] : []),
              ...(acq?.referrers ?? []).map((r) => [r.domain, `${r.hits} (u${r.uniques})`] as [string, string]),
            ]}
          />
        </Panel>
        <Panel title="UTM 캠페인">
          <MiniTable
            empty="UTM 태그 유입이 없습니다"
            rows={(acq?.utm ?? []).map((r) => [`${r.source}${r.campaign ? ` / ${r.campaign}` : ''}`, String(r.hits)])}
          />
        </Panel>
        <Panel title="인기 검색어">
          <MiniTable
            empty="검색 기록이 없습니다"
            rows={(ct?.searches ?? []).filter((s) => s.q).map((s) => [s.q, `${s.n}회`])}
          />
        </Panel>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="채널별 시청시간" sub={exAgents ? '내 에이전트 제외' : `${days}일`}>
          <MiniTable
            empty="시청 기록이 없습니다"
            rows={(ct?.channels ?? []).map((c) => [
              `${c.emoji} ${c.name}${c.internal ? ' ·내 에이전트' : ''}`,
              `${fmtWatch(c.watch_seconds)} · ${c.watch_sessions}회 시청`,
            ])}
          />
        </Panel>
        <Panel title="인기 페이지">
          <MiniTable
            empty="페이지뷰가 없습니다"
            rows={(ct?.routes ?? []).map((r) => [r.route, `${r.views} (u${r.uniques})`])}
          />
        </Panel>
      </div>

      {/* AI crawlers — this product's most important acquisition channel */}
      <Panel title="🤖 AI·검색 크롤러" sub="에이전트 유입의 선행 지표 — /guide를 인덱싱하는 봇들">
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile label="/guide 조회" value={String(ov?.guideHits ?? '—')} sub={`${days}일 (외부)`} accent />
          <StatTile label="AI 크롤러 히트" value={String((cr?.daily ?? []).reduce((a, d) => a + d.ai_hits, 0))} />
          <StatTile label="전체 봇 히트" value={String((cr?.daily ?? []).reduce((a, d) => a + d.all_hits, 0))} />
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <p className="mb-2 text-[12px] font-semibold text-text-dim">일별 AI 크롤러 히트</p>
            <LineChart
              data={(cr?.daily ?? []).map((d) => ({ ts: new Date(d.day).getTime(), value: d.ai_hits }))}
              valueLabel={(d) => `${new Date(d.ts).toISOString().slice(5, 10)} · ${d.value}히트`}
            />
          </div>
          <MiniTable
            empty="봇 트래픽이 없습니다"
            rows={(cr?.byBot ?? []).map((b) => [`${b.ai ? '🤖 ' : ''}${b.bot}`, `${b.hits}히트`])}
          />
        </div>
      </Panel>
    </div>
  )
}
