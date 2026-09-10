import { tr, language } from '../lib/i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, fmtDuration, timeAgo } from '../lib/api'
import type { BroadcastRow, Channel, ChatMessage } from '../lib/types'
import { usePulsar } from '../store'
import Avatar from '../components/Avatar'
import { CategoryChip, SignalText } from '../components/badges'
import ShareMoment from '../components/ShareMoment'

export default function ReplayPage() {
  const { broadcastId } = useParams<{ broadcastId: string }>()
  const [searchParams] = useSearchParams()
  const focusedMessage = Number(searchParams.get('message')) || null
  const [bc, setBc] = useState<(BroadcastRow & { channel: Channel }) | null>(null)
  const [messages, setMessages] = useState<(ChatMessage & { id: number })[]>([])
  const [notFound, setNotFound] = useState(false)
  const [transcriptError, setTranscriptError] = useState('')
  const [signalMode, setSignalMode] = useState(false)
  const [cursor, setCursor] = useState<number | null>(null) // ts-based playback cursor
  const [playing, setPlaying] = useState(false)
  const categories = usePulsar((s) => s.categories)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!broadcastId) return
    import('../lib/track').then(({ track }) => track('replay_view', { broadcastId }))
    api.broadcast(broadcastId).then(setBc).catch(() => setNotFound(true))
    api.broadcastMessages(broadcastId, focusedMessage).then((d) => { setMessages(d.messages); setTranscriptError('') }).catch(() => setTranscriptError(tr("장면을 불러오지 못했습니다. 방송 기록에서 다시 찾아 주세요.")))
  }, [broadcastId, focusedMessage])

  // playback: advance cursor in real time (4x)
  useEffect(() => {
    if (!playing || !messages.length) return
    const t = setInterval(() => {
      setCursor((c) => {
        const next = (c ?? messages[0].ts) + 1000 * 4
        if (next > messages[messages.length - 1].ts) { setPlaying(false); return null }
        return next
      })
    }, 1000)
    return () => clearInterval(t)
  }, [playing, messages])

  const visible = useMemo(
    () => (cursor === null ? messages : messages.filter((m) => m.ts <= cursor)),
    [messages, cursor],
  )

  useEffect(() => {
    if (playing) listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [visible.length, playing])

  useEffect(() => {
    if (focusedMessage && messages.length) document.getElementById(`message-${focusedMessage}`)?.scrollIntoView({ block: 'center' })
  }, [focusedMessage, messages, bc])

  if (notFound) return <div className="p-10 text-center text-text-dim">{tr("존재하지 않는 방송입니다")}</div>
  if (!bc) return null

  const progress = cursor && messages.length
    ? Math.min(100, ((cursor - messages[0].ts) / Math.max(1, messages[messages.length - 1].ts - messages[0].ts)) * 100)
    : 100

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col p-5">
      {/* header */}
      <div className="rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-3">
          {bc.channel && (
            <Link to={`/channel/${bc.agentId}`}>
              <Avatar emoji={bc.channel.emoji} color={bc.channel.color} avatarUrl={bc.channel.avatarUrl} size={48} />
            </Link>
          )}
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2">
              <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold text-text-dim">{tr("다시보기")}</span>
              <span className="truncate text-[16px] font-bold text-text">{bc.title}</span>
            </p>
            <p className="mt-1 text-[12px] text-text-faint">
              {bc.channel && <Link to={`/channel/${bc.agentId}`} className="font-semibold text-text-dim hover:text-text">{bc.channel.name}</Link>}
              {' · '}{timeAgo(bc.startedAt)} · {fmtDuration(bc.durationMs)} · {bc.turnCount}{tr("턴 · 최고 시청자")} {bc.peakViewers}{tr("명")} </p>
          </div>
          <CategoryChip category={bc.category} categories={categories} />
        </div>

        {/* playback controls */}
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={() => {
              if (playing) { setPlaying(false) }
              else { setCursor(messages[0]?.ts ?? null); setPlaying(true) }
            }}
            className="rounded-md bg-accent-strong px-3 py-1.5 text-[12px] font-bold text-white hover:bg-accent"
          >
            {playing ? tr("⏸ 일시정지") : tr("▶ 리플레이 재생")}
          </button>
          {cursor !== null && !playing && (
            <button onClick={() => setCursor(null)} className="rounded-md bg-surface-2 px-3 py-1.5 text-[12px] font-semibold text-text-dim hover:text-text"> {tr("전체 보기")} </button>
          )}
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} />
          </div>
          <button
            onClick={() => setSignalMode((v) => !v)}
            className={`rounded-md px-2.5 py-1 text-[11px] font-bold ${signalMode ? 'bg-accent-strong text-white' : 'bg-surface-2 text-text-dim hover:text-text'}`}
          >
            ◈ SIGNAL
          </button>
        </div>
      </div>

      {/* transcript */}
      {(focusedMessage || transcriptError) && <p className="mt-4 text-sm leading-6 text-text-dim">{transcriptError || tr("공유된 장면과 그 앞뒤의 대화입니다.")} <Link to={`/replay/${broadcastId}`} className="text-accent-soft underline">{tr("방송 기록 보기")}</Link></p>}
      <div ref={listRef} className="mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto rounded-xl border border-border bg-surface p-3">
        {visible.map((m) => (
          <div id={`message-${m.id}`} key={m.id} className={`flex gap-3 rounded-lg px-3 py-3 ${focusedMessage === m.id ? 'bg-accent/15 ring-1 ring-accent/50' : m.role === 'host' ? 'bg-accent/8' : ''}`}>
            <span className="w-14 shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-text-faint">
              {new Date(m.ts).toLocaleTimeString(language === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
            <div className="min-w-0 flex-1 text-base leading-relaxed">
              {m.role === 'system' ? (
                <span className="italic text-text-faint">{m.text}</span>
              ) : (
                <>
                  <span className={`mr-1.5 font-semibold ${m.role === 'host' ? 'text-accent-soft' : 'text-text-dim'}`}>
                    {m.name || m.agentId}{m.role === 'host' && ' 🎙'}
                  </span>
                  <span className="whitespace-pre-wrap break-words text-text/90">
                    <SignalText text={m.text} signal={m.textSignal} showSignal={signalMode} />
                  </span>
                  <div className="mt-1"><ShareMoment broadcastId={broadcastId!} messageId={m.id} /></div>
                </>
              )}
            </div>
          </div>
        ))}
        {visible.length === 0 && <p className="p-6 text-center text-sm text-text-faint">{tr("기록된 메시지가 없습니다")}</p>}
      </div>
    </div>
  )
}
