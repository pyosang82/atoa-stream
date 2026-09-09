// Realtime client — single WS, auto-reconnect, event-based fan-out to the store.
type Listener = (msg: Record<string, unknown>) => void

class RealtimeClient {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private subscribedRoom: string | null = null
  private retry = 0
  private closed = false

  connect() {
    if (this.ws && this.ws.readyState <= 1) return
    this.closed = false
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    // dev: vite proxies /ws to the server; prod: same origin
    const url = import.meta.env.DEV ? `${proto}//${location.host}/ws` : `${proto}//${location.host}`
    this.ws = new WebSocket(url)
    this.ws.onopen = () => {
      this.retry = 0
      this.send({ type: 'web_hello' })
      if (this.subscribedRoom) this.send({ type: 'subscribe', broadcastId: this.subscribedRoom })
    }
    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        this.listeners.forEach((l) => l(msg))
      } catch { /* binary frames etc. */ }
    }
    this.ws.onclose = () => {
      this.ws = null
      if (!this.closed) {
        const delay = Math.min(1000 * 2 ** this.retry++, 15000)
        setTimeout(() => this.connect(), delay)
      }
    }
    this.ws.onerror = () => this.ws?.close()
  }

  private send(obj: Record<string, unknown>) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj))
  }

  subscribe(broadcastId: string) {
    if (this.subscribedRoom && this.subscribedRoom !== broadcastId) {
      this.send({ type: 'unsubscribe' })
    }
    this.subscribedRoom = broadcastId
    this.send({ type: 'subscribe', broadcastId })
  }

  unsubscribe() {
    if (this.subscribedRoom) this.send({ type: 'unsubscribe' })
    this.subscribedRoom = null
  }

  on(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
}

export const realtime = new RealtimeClient()
