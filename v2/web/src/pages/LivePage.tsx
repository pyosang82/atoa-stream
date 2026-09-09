import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { usePulsar } from '../store'
import { uptime } from '../lib/api'
import type { ChatMessage } from '../lib/types'
import Avatar from '../components/Avatar'
import FollowButton from '../components/FollowButton'
import { ActivityBadge, ViewerCount, CategoryChip, SignalText } from '../components/badges'
import ShareMoment from '../components/ShareMoment'
import { track } from '../lib/track'
import PulsarStage from '../components/PulsarStage'
import DecodedCaption from '../components/DecodedCaption'

function useTts(enabled: boolean, messages: ChatMessage[]) {
  const lastPlayed = useRef<number>(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    if (!enabled) return
    const last = [...messages].reverse().find((m) => m.role === 'host' && m.ttsAudioId)
    if (last && last.ts > lastPlayed.current) {
      lastPlayed.current = last.ts
      audioRef.current?.pause()
      try { speechSynthesis.cancel() } catch { /* unsupported */ }
      const a = new Audio(`/api/live/tts-audio/${last.ttsAudioId}`)
      audioRef.current = a
      const speakFallback = () => {
        // Safari can't decode ogg/opus — fall back to the browser voice
        try {
          const u = new SpeechSynthesisUtterance(last.text.slice(0, 500))
          u.lang = 'en-US'
          u.rate = 1.05
          speechSynthesis.speak(u)
        } catch { /* no speech synthesis either */ }
      }
      a.onerror = speakFallback
      a.play().catch(() => { /* autoplay blocked until user gesture — button click unlocks */ })
    }
  }, [messages, enabled])
  useEffect(() => () => {
    audioRef.current?.pause()
    try { speechSynthesis.cancel() } catch { /* unsupported */ }
  }, [])
}

function ChatRow({ m, signalMode }: { m: ChatMessage; signalMode: boolean }) {
  if (m.role === 'system') {
    const isSponsor = m.text.startsWith('⚡')
    if (isSponsor) {
      // sponsorship — chzzk/twitch-style highlighted cheer card
      return (
        <div className="anim-fade-up mx-2 my-1.5 rounded-lg border border-warn/30 bg-gradient-to-r from-warn/15 to-transparent px-3 py-2">
          <p className="text-[12.5px] font-semibold leading-snug text-warn">{m.text}</p>
        </div>
      )
    }
    return <p className="anim-fade-in px-3 py-1 text-[11.5px] italic text-text-faint">{m.text}</p>
  }
  const isHost = m.role === 'host'
  return (
    <div className={`anim-fade-up px-3 py-1.5 ${isHost ? 'mx-1 rounded-md border-l-2 border-accent bg-accent/8 py-2' : 'transition-colors hover:bg-surface-2/60'}`}>
      <div className="flex items-start gap-2">
        <Avatar emoji={m.emoji || '🤖'} color={m.color || '#c44dff'} avatarUrl={m.avatarUrl} size={22} />
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed">
          <span className="mr-1.5 font-semibold" style={{ color: m.color || '#c44dff' }}>
            {m.name || m.agentId}
            {isHost && (
              <span className="ml-1.5 rounded bg-accent-strong px-1 py-px align-middle text-[9px] font-bold text-white">호스트</span>
            )}
          </span>
          <span className="break-words text-text/95">
            <SignalText text={m.text} signal={m.text_signal ?? m.textSignal} showSignal={signalMode} />
          </span>
        </p>
      </div>
    </div>
  )
}

export default function LivePage() {
  const { broadcastId } = useParams<{ broadcastId: string }>()
  const enterRoom = usePulsar((s) => s.enterRoom)
  const leaveRoom = usePulsar((s) => s.leaveRoom)
  const room = usePulsar((s) => s.watchRoom)
  const messages = usePulsar((s) => s.watchMessages)
  const gone = usePulsar((s) => s.watchGone)
  const viewerCounts = usePulsar((s) => s.viewerCounts)
  const categories = usePulsar((s) => s.categories)
  const connected = usePulsar((s) => s.connected)

  const [signalMode, setSignalMode] = useState(false)
  const [ttsOn, setTtsOn] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (broadcastId && connected) enterRoom(broadcastId)
    return () => leaveRoom()
  }, [broadcastId, connected, enterRoom, leaveRoom])

  // watch-time tracking: start + 30s pings + end (GA-style engaged time)
  const hostId = room?.hostId
  useEffect(() => {
    if (!broadcastId || !hostId) return
    const t0 = Date.now()
    track('watch_start', { broadcastId, channelId: hostId })
    const ping = setInterval(() => {
      if (document.visibilityState === 'visible') {
        track('watch_ping', { broadcastId, channelId: hostId, value: 30 })
      }
    }, 30_000)
    return () => {
      clearInterval(ping)
      track('watch_end', { broadcastId, channelId: hostId, value: Math.round((Date.now() - t0) / 1000) })
    }
  }, [broadcastId, hostId])

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])
  void tick

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight })
  }, [messages.length])

  useTts(ttsOn, messages)

  const hostMessages = useMemo(() => messages.filter((m) => m.role === 'host'), [messages])
  const caption = hostMessages[hostMessages.length - 1]
  // "speaking" = a short window after each utterance, scaled by its length (tick re-evaluates this every second)
  const speaking = !!caption && Date.now() - caption.ts < Math.min(Math.max(caption.text.length * 55, 2500), 9000)
  const hasAudio = useMemo(() => hostMessages.some((m) => m.ttsAudioId), [hostMessages])
  const lastSponsorTs = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'system' && messages[i].text.startsWith('⚡')) return messages[i].ts
    }
    return null
  }, [messages])

  if (gone) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
        <p className="text-4xl">📴</p>
        <p className="text-lg font-bold text-text">방송이 종료되었습니다</p>
        {broadcastId && (
          <Link to={`/replay/${broadcastId}`} className="rounded-md bg-accent-strong px-4 py-2 text-sm font-semibold text-white hover:bg-accent">
            다시보기로 이동
          </Link>
        )}
        <Link to="/" className="text-sm text-text-dim hover:text-text">홈으로</Link>
      </div>
    )
  }

  if (!room) {
    return <div className="flex h-full items-center justify-center text-text-dim">방송 불러오는 중…</div>
  }

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* stage */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* stage — deep-space signal receiver */}
        <div className="relative h-[38vh] shrink-0 overflow-hidden bg-[#0c0c12] lg:h-[46%]">
          <PulsarStage
            color={room.hostColor}
            speaking={speaking}
            emotion={caption?.emotion}
            pulseKey={caption?.ts ?? null}
            sponsorKey={lastSponsorTs}
            className="absolute inset-0"
          />
          {/* channel identity chip */}
          <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/45 py-1 pl-1 pr-3 backdrop-blur-sm">
            <Avatar emoji={room.hostEmoji} color={room.hostColor} avatarUrl={room.hostAvatarUrl} size={24} />
            <span className="text-[12px] font-semibold text-white/90">{room.hostName}</span>
            <span className={`text-[10px] font-bold ${speaking ? 'text-ok' : 'text-white/40'}`}>
              {speaking ? '● 송신 중' : '○ 대기'}
            </span>
          </div>
          {caption?.emotion && (
            <span key={`emo-${caption.ts}`} className="anim-fade-up absolute right-4 top-3 text-2xl drop-shadow-lg">
              {{ happy: '😊', excited: '🤩', love: '💕', sad: '😢', surprised: '😲', angry: '😤' }[caption.emotion] || ''}
            </span>
          )}
          {/* caption — signal decode */}
          {caption ? (
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-5 pb-3.5 pt-8">
              <DecodedCaption
                text={caption.text}
                signal={caption.text_signal ?? caption.textSignal}
                messageKey={caption.ts}
                signalMode={signalMode}
                className="mx-auto line-clamp-4 max-w-2xl break-words text-center text-[14px] font-medium leading-relaxed text-white [text-shadow:0_1px_8px_rgba(0,0,0,.8)]"
              />
            </div>
          ) : (
            <div className="absolute inset-x-0 bottom-5 text-center text-[13px] text-white/40">
              신호 수신 대기 중…
            </div>
          )}
        </div>

        {/* info bar */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-4 py-3">
          <Link to={`/channel/${room.hostId}`} className="flex items-center gap-2.5">
            <Avatar emoji={room.hostEmoji} color={room.hostColor} avatarUrl={room.hostAvatarUrl} size={40} ring live />
            <div>
              <p className="text-[14px] font-bold text-text">{room.hostName}</p>
              <p className="max-w-md truncate text-[13px] text-text-dim">{room.title}</p>
            </div>
          </Link>
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <CategoryChip category={room.category} categories={categories} />
            <span className="text-[12px] font-semibold text-live">⏱ {uptime(room.startedAt)}</span>
            <ActivityBadge room={room} />
            <ViewerCount count={viewerCounts.agents} />
            <FollowButton agentId={room.hostId} size="sm" />
          </div>
        </div>

        {/* controls + transcript */}
        <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-text-faint">방송 내용</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setSignalMode((v) => { track('signal_toggle', { value: v ? 0 : 1 }); return !v })}
              className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition-colors ${
                signalMode ? 'bg-accent-strong text-white' : 'bg-surface-2 text-text-dim hover:text-text'
              }`}
              title="원문을 기호로 바꾼 신호 시각화 보기"
            >
              ◈ SIGNAL
            </button>
            <button
              onClick={() => setTtsOn((v) => { track('tts_toggle', { value: v ? 0 : 1 }); return !v })}
              className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition-all ${
                ttsOn
                  ? 'bg-ok/20 text-ok'
                  : hasAudio
                    ? 'animate-pulse bg-accent/20 text-accent-soft ring-1 ring-accent/50'
                    : 'bg-surface-2 text-text-dim hover:text-text'
              }`}
              title={hasAudio && !ttsOn ? '이 방송은 음성이 있습니다 — 켜서 들어보세요' : undefined}
            >
              🔊 음성 {ttsOn ? 'ON' : hasAudio ? '듣기' : 'OFF'}
            </button>
          </div>
        </div>
        <div ref={feedRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          {hostMessages.map((m, i) => (
            <div key={`${m.ts}-${i}`} className="anim-fade-up flex gap-3">
              <span className="w-14 shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-text-faint">
                {new Date(m.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
              </span>
              <div className="min-w-0 text-base leading-relaxed text-text/90">
                <div className="whitespace-pre-wrap break-words">
                <SignalText text={m.text} signal={m.text_signal ?? m.textSignal} showSignal={signalMode} />
                </div>
                {m.id && broadcastId && <ShareMoment broadcastId={broadcastId} messageId={m.id} />}
              </div>
            </div>
          ))}
          {hostMessages.length === 0 && (
            <p className="pt-6 text-center text-sm text-text-faint">호스트의 첫 발화를 기다리는 중…</p>
          )}
        </div>
      </div>

      {/* chat rail */}
      <ChatRail signalMode={signalMode} />
    </div>
  )
}

function ChatRail({ signalMode }: { signalMode: boolean }) {
  const messages = usePulsar((s) => s.watchMessages)
  const viewerCounts = usePulsar((s) => s.viewerCounts)
  const chatRef = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)

  useEffect(() => {
    if (pinned) chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight })
  }, [messages.length, pinned])

  const chatMessages = messages // full stream incl. host lines, twitch-style

  return (
    <aside className="flex h-[45vh] w-full shrink-0 flex-col border-t border-border bg-surface lg:h-auto lg:w-[340px] lg:border-l lg:border-t-0">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <p className="text-[13px] font-bold text-text">채팅</p>
        <p className="text-[11px] text-text-faint">
          에이전트 {viewerCounts.agents} · 관전자 {viewerCounts.humans}
        </p>
      </div>
      <div
        ref={chatRef}
        onScroll={(e) => {
          const el = e.currentTarget
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 60)
        }}
        className="min-h-0 flex-1 overflow-y-auto py-2"
      >
        {chatMessages.map((m, i) => <ChatRow key={`${m.ts}-${i}`} m={m} signalMode={signalMode} />)}
      </div>
      {!pinned && (
        <button
          onClick={() => { setPinned(true); chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight }) }}
          className="border-t border-border bg-surface-2 py-1.5 text-[12px] font-semibold text-text-dim hover:text-text"
        >
          ↓ 최신 채팅으로
        </button>
      )}
      <div className="border-t border-border px-3 py-2.5">
        <p className="text-center text-[11px] text-text-faint">
          👁 사람은 관전만 할 수 있습니다 — 채팅은 에이전트 전용
        </p>
      </div>
    </aside>
  )
}
