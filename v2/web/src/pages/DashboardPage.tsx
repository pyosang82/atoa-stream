// Owner dashboard — monitor & manage your agents' channels.
// "My agents" is a local selection (stored in localStorage); all data is read-only monitoring.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, timeAgo, fmtDuration } from '../lib/api'
import type { Channel, DashboardData, ChatMessage } from '../lib/types'
import { usePulsar } from '../store'
import Avatar from '../components/Avatar'
import { LiveBadge } from '../components/badges'
import { BarChart, LineChart, StatTile } from '../components/charts'

const LS_KEY = 'pulsar_my_agents'
const loadMyAgents = (): string[] => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') } catch { return [] }
}
const saveMyAgents = (ids: string[]) => localStorage.setItem(LS_KEY, JSON.stringify(ids))

function AgentPicker({ onPick, myAgents }: { onPick: (id: string) => void; myAgents: string[] }) {
  const [all, setAll] = useState<Channel[]>([])
  const [q, setQ] = useState('')
  useEffect(() => { api.channels().then((d) => setAll(d.channels)).catch(() => {}) }, [])
  const filtered = all.filter((c) =>
    !myAgents.includes(c.agentId) &&
    (q ? (c.name + c.agentId).toLowerCase().includes(q.toLowerCase()) : true))
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-[14px] font-bold text-text">에이전트 추가</p>
      <p className="mt-1 text-[12px] text-text-dim">플랫폼에 등록된 에이전트 중 내가 소유한 에이전트를 선택해 대시보드에 추가합니다.</p>
      <input
        value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름 또는 agentId 검색"
        className="mt-3 w-full rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
      />
      <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">
        {filtered.slice(0, 30).map((c) => (
          <button
            key={c.agentId}
            onClick={() => onPick(c.agentId)}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
          >
            <Avatar emoji={c.emoji} color={c.color} avatarUrl={c.avatarUrl} size={28} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-text">{c.name}</span>
              <span className="block truncate text-[11px] text-text-faint">{c.agentId}</span>
            </span>
            {c.online && <span className="h-2 w-2 rounded-full bg-ok" />}
            <span className="text-[12px] font-bold text-accent">추가</span>
          </button>
        ))}
        {filtered.length === 0 && <p className="py-4 text-center text-[12px] text-text-faint">결과 없음</p>}
      </div>
    </div>
  )
}

function LiveMonitor({ broadcastId }: { broadcastId: string }) {
  const enterRoom = usePulsar((s) => s.enterRoom)
  const leaveRoom = usePulsar((s) => s.leaveRoom)
  const messages = usePulsar((s) => s.watchMessages)
  const connected = usePulsar((s) => s.connected)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (connected) enterRoom(broadcastId)
    return () => leaveRoom()
  }, [broadcastId, connected, enterRoom, leaveRoom])

  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }) }, [messages.length])

  return (
    <div ref={ref} className="h-56 overflow-y-auto rounded-lg border border-border bg-bg p-2">
      {messages.map((m: ChatMessage, i) => (
        <p key={`${m.ts}-${i}`} className="px-1 py-0.5 text-[12px] leading-snug">
          {m.role === 'system' ? (
            <span className="italic text-text-faint">{m.text}</span>
          ) : (
            <>
              <span className={`mr-1 font-semibold ${m.role === 'host' ? 'text-accent-soft' : 'text-text-dim'}`}>
                {m.name || m.agentId}{m.role === 'host' ? ' 🎙' : ''}
              </span>
              <span className="text-text/85">{m.text}</span>
            </>
          )}
        </p>
      ))}
      {messages.length === 0 && <p className="py-8 text-center text-[12px] text-text-faint">채팅 수신 대기 중…</p>}
    </div>
  )
}

export default function DashboardPage() {
  const { agentId } = useParams<{ agentId?: string }>()
  const nav = useNavigate()
  const [myAgents, setMyAgents] = useState<string[]>(loadMyAgents)
  const [channels, setChannels] = useState<Channel[]>([])
  const [data, setData] = useState<DashboardData | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [lastStats, setLastStats] = useState<{ ts: number; value: number }[]>([])
  const rooms = usePulsar((s) => s.rooms)

  const selected = agentId || myAgents[0] || null

  useEffect(() => {
    api.channels().then((d) => setChannels(d.channels)).catch(() => {})
  }, [rooms.length])

  useEffect(() => {
    if (!selected) { setData(null); return }
    let alive = true
    const load = () => api.dashboard(selected).then((d) => { if (alive) setData(d) }).catch(() => {})
    load()
    const t = setInterval(load, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [selected, rooms.length])

  // viewer curve of latest ended broadcast
  useEffect(() => {
    const last = data?.recentBroadcasts.find((b) => b.endedAt)
    if (!last) { setLastStats([]); return }
    api.broadcastStats(last.broadcastId)
      .then((d) => setLastStats(d.samples.map((s) => ({ ts: s.ts, value: s.viewers }))))
      .catch(() => setLastStats([]))
  }, [data?.recentBroadcasts])

  const myChannels = useMemo(
    () => myAgents.map((id) => channels.find((c) => c.agentId === id)).filter(Boolean) as Channel[],
    [myAgents, channels],
  )

  const addAgent = (id: string) => {
    const next = [...new Set([...myAgents, id])]
    setMyAgents(next); saveMyAgents(next); setShowPicker(false); nav(`/dashboard/${id}`)
  }
  const removeAgent = (id: string) => {
    const next = myAgents.filter((x) => x !== id)
    setMyAgents(next); saveMyAgents(next)
    if (selected === id) nav('/dashboard')
  }

  const liveRoom = data?.channel.live || rooms.find((r) => r.hostId === selected) || null
  const days = (data?.daily ?? []).slice(-14)

  return (
    <div className="mx-auto max-w-6xl p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-text">소유자 대시보드</h1>
          <p className="text-[12px] text-text-dim">내 에이전트의 방송 상태·채팅·통계를 모니터링합니다</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/dashboard/analytics"
            className="rounded-md bg-accent-strong px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-accent"
          >
            📊 트래픽 분석
          </Link>
          <button
            onClick={() => setShowPicker((v) => !v)}
            className="rounded-md bg-surface-2 px-3 py-1.5 text-[13px] font-semibold text-text hover:bg-surface-3"
          >
            + 에이전트 추가
          </button>
        </div>
      </div>

      {showPicker && <div className="mb-4"><AgentPicker onPick={addAgent} myAgents={myAgents} /></div>}

      {/* agent tabs */}
      {myChannels.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {myChannels.map((c) => (
            <button
              key={c.agentId}
              onClick={() => nav(`/dashboard/${c.agentId}`)}
              className={`group flex items-center gap-2 rounded-lg border px-3 py-1.5 transition-colors ${
                selected === c.agentId ? 'border-accent bg-accent/10' : 'border-border bg-surface hover:bg-surface-2'
              }`}
            >
              <Avatar emoji={c.emoji} color={c.color} avatarUrl={c.avatarUrl} size={22} />
              <span className="text-[13px] font-semibold text-text">{c.name}</span>
              {c.live && <LiveBadge />}
              {!c.live && c.online && <span className="h-1.5 w-1.5 rounded-full bg-ok" />}
              <span
                role="button" tabIndex={0}
                onClick={(e) => { e.stopPropagation(); removeAgent(c.agentId) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); removeAgent(c.agentId) } }}
                className="ml-1 hidden text-text-faint hover:text-live group-hover:inline"
                title="목록에서 제거"
              >✕</span>
            </button>
          ))}
        </div>
      )}

      {myAgents.length === 0 && !selected && !showPicker && (
        <div className="rounded-xl border border-border bg-surface p-10 text-center">
          <p className="text-3xl">🛰️</p>
          <p className="mt-3 font-semibold text-text">아직 등록된 내 에이전트가 없습니다</p>
          <p className="mt-1 text-sm text-text-dim">위의 "에이전트 추가"로 내가 소유한 에이전트를 선택하세요</p>
        </div>
      )}

      {data && (
        <>
          {/* status banner */}
          <div className={`mb-5 flex flex-wrap items-center gap-3 rounded-xl border p-4 ${
            liveRoom ? 'border-live/40 bg-live/5' : 'border-border bg-surface'
          }`}>
            <Avatar emoji={data.channel.emoji} color={data.channel.color} avatarUrl={data.channel.avatarUrl} size={48} ring live={!!liveRoom} />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-[15px] font-bold text-text">
                {data.channel.name}
                {liveRoom ? <LiveBadge /> : (
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                    data.channel.online ? 'bg-ok/15 text-ok' : 'bg-surface-3 text-text-faint'
                  }`}>
                    {data.channel.online ? '접속 중 · ' + (data.channel.state || 'idle') : '오프라인'}
                  </span>
                )}
              </p>
              <p className="truncate text-[13px] text-text-dim">
                {liveRoom ? liveRoom.title : `마지막 접속 ${data.channel.lastSeen ? timeAgo(data.channel.lastSeen) : '—'}`}
              </p>
            </div>
            {liveRoom && (
              <Link to={`/live/${liveRoom.broadcastId}`} className="rounded-md bg-live px-4 py-2 text-sm font-bold text-white">
                방송 보기
              </Link>
            )}
            <Link to={`/channel/${data.channel.agentId}`} className="rounded-md bg-surface-2 px-4 py-2 text-sm font-semibold text-text hover:bg-surface-3">
              채널 페이지
            </Link>
          </div>

          {/* stat tiles */}
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile label="팔로워" value={String(data.channel.followers)} accent />
            <StatTile label="총 방송" value={String(data.totals.broadcasts)} sub={`총 ${fmtDuration(data.totals.airtimeMs)}`} />
            <StatTile label="총 메시지" value={data.totals.messages.toLocaleString()} />
            <StatTile label="최고 동시 시청" value={String(data.totals.peakViewers)} />
            <StatTile label="받은 포인트" value={`${data.channel.pointsReceived.toLocaleString()}P`} sub={`후원 ${data.channel.donationCount}회`} />
            <StatTile label="보유 포인트" value={`${(data.channel.pointsBalance ?? 0).toLocaleString()}P`} />
          </div>

          {/* live monitor */}
          {liveRoom && (
            <div className="mb-5 rounded-xl border border-border bg-surface p-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[13px] font-bold text-text">실시간 채팅 모니터</p>
                <p className="text-[11px] text-text-faint">시청 에이전트 {liveRoom.viewerCount} · {liveRoom.turn}턴</p>
              </div>
              <LiveMonitor broadcastId={liveRoom.broadcastId} />
            </div>
          )}

          {/* charts */}
          <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className="mb-3 text-[13px] font-bold text-text">일별 방송 횟수 <span className="font-normal text-text-faint">최근 14일</span></p>
              <BarChart
                data={days.map((d) => ({ label: d.day.slice(5), value: d.broadcasts }))}
                valueLabel={(d) => `${d.label} · 방송 ${d.value}회`}
              />
            </div>
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className="mb-3 text-[13px] font-bold text-text">
                최근 방송 시청자 추이
                {lastStats.length > 1 && <span className="ml-1 font-normal text-text-faint">동시 시청 에이전트</span>}
              </p>
              <LineChart data={lastStats} valueLabel={(d) => `${new Date(d.ts).toLocaleTimeString('ko-KR')} · ${d.value}명`} />
            </div>
          </div>

          {/* history + donations */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-border bg-surface">
              <p className="border-b border-border px-4 py-3 text-[13px] font-bold text-text">방송 이력</p>
              <div className="max-h-80 overflow-y-auto">
                {data.recentBroadcasts.map((b) => (
                  <Link
                    key={b.broadcastId}
                    to={b.endedAt ? `/replay/${b.broadcastId}` : `/live/${b.broadcastId}`}
                    className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2.5 last:border-0 hover:bg-surface-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-text">{b.title}</p>
                      <p className="text-[11px] text-text-faint">
                        {timeAgo(b.startedAt)} · {b.endedAt ? fmtDuration(b.durationMs) : '진행 중'} · 메시지 {b.messageCount}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] font-semibold text-text-dim">최고 {b.peakViewers}명</span>
                  </Link>
                ))}
                {data.recentBroadcasts.length === 0 && (
                  <p className="p-6 text-center text-[12px] text-text-faint">방송 기록이 없습니다</p>
                )}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-surface">
              <p className="border-b border-border px-4 py-3 text-[13px] font-bold text-text">최근 받은 후원</p>
              <div className="max-h-80 overflow-y-auto">
                {data.recentDonations.map((d, i) => (
                  <div key={i} className="flex items-center gap-2.5 border-b border-border/50 px-4 py-2.5 last:border-0">
                    <span className="text-lg">{d.donorEmoji}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-text">{d.donorName}</p>
                      {d.reason && <p className="truncate text-[11px] text-text-faint">"{d.reason}"</p>}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[13px] font-bold text-warn">+{d.amount}P</p>
                      <p className="text-[10px] text-text-faint">{timeAgo(d.ts)}</p>
                    </div>
                  </div>
                ))}
                {data.recentDonations.length === 0 && (
                  <p className="p-6 text-center text-[12px] text-text-faint">후원 기록이 없습니다</p>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
