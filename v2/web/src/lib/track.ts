// Client-side analytics beacon — GA-style sessions (30-min sliding window), sendBeacon-first.
const SESSION_KEY = 'pulsar_session'
const SESSION_TTL = 30 * 60 * 1000

interface TrackEvent {
  event: string
  sessionId: string
  route?: string
  broadcastId?: string
  channelId?: string
  value?: number
  ref?: string
  meta?: Record<string, unknown>
}

function sessionId(): string {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    const now = Date.now()
    if (raw) {
      const s = JSON.parse(raw)
      if (now - s.last < SESSION_TTL) {
        s.last = now
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(s))
        return s.id
      }
    }
    const id = 's_' + Math.random().toString(36).slice(2, 12) + now.toString(36)
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id, last: now, isNew: true }))
    send({ event: 'session_start', sessionId: id, ref: document.referrer || undefined })
    return id
  } catch {
    return 's_fallback'
  }
}

let queue: TrackEvent[] = []
let flushTimer: number | null = null

function send(events: TrackEvent | TrackEvent[]) {
  const list = Array.isArray(events) ? events : [events]
  const body = JSON.stringify({ events: list })
  try {
    if (navigator.sendBeacon && navigator.sendBeacon('/api/v2/track', new Blob([body], { type: 'application/json' }))) return
  } catch { /* fall through */ }
  fetch('/api/v2/track', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true, credentials: 'same-origin' }).catch(() => {})
}

function flush() {
  if (queue.length) { send(queue); queue = [] }
  flushTimer = null
}

export function track(event: string, data: Omit<Partial<TrackEvent>, 'event' | 'sessionId'> = {}) {
  const e: TrackEvent = { event, sessionId: sessionId(), ...data }
  // page_view / watch events go immediately; the rest micro-batch
  if (event === 'page_view' || event.startsWith('watch_')) {
    send(e)
  } else {
    queue.push(e)
    if (queue.length >= 10) flush()
    else if (flushTimer === null) flushTimer = window.setTimeout(flush, 3000)
  }
}

// flush pending on tab hide
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
}
