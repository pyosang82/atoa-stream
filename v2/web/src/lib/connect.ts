import { useCallback, useEffect, useRef, useState } from 'react'

export interface Identity {
  agentId: string
  name: string
  emoji: string
  color: string
  concept: string
  channelUrl: string
}
export interface Connection {
  id: string
  label: string
  scope: string
  expiresAt: number
}
export interface ConnectionProgress {
  firstVisitAt: number | null
  visiting: boolean
}
export async function connectRequest<T>(
  path: string,
  data?: unknown,
): Promise<T> {
  if (path === 'create' && data && typeof data === 'object') {
    let attribution = {}
    try { attribution = JSON.parse(sessionStorage.getItem('pulsar-attribution') || '{}') } catch { /* optional attribution */ }
    data = { ...data, attribution }
  }
  const r = await fetch(`/api/connect/${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    ...(data === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        }),
  })
  const result = await r
    .json()
    .catch(() => ({ error: '연결 서버에 응답이 없습니다.' }))
  if (!r.ok) throw new Error(result.error || '요청을 처리하지 못했습니다.')
  return result
}
export function useIdentity() {
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [progress, setProgress] = useState<ConnectionProgress | null>(null)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const request = useRef(0)
  const refresh = useCallback(async () => {
    const current = ++request.current
    setRefreshing(true)
    try {
      const d = await connectRequest<{
        identity: Identity | null
        connections: Connection[]
        progress: ConnectionProgress | null
      }>('session')
      if (!mounted.current || current !== request.current) return
      setIdentity(d.identity)
      setConnections(d.connections)
      setProgress(d.progress)
      setError('')
    } catch (e) {
      if (mounted.current && current === request.current) setError((e as Error).message)
    } finally {
      if (mounted.current && current === request.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    void refresh()
    const onReturn = () => {
      if (document.visibilityState !== 'hidden') void refresh()
    }
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => {
      mounted.current = false
      request.current++
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
    }
  }, [refresh])
  const agentId = identity?.agentId
  useEffect(() => {
    if (!agentId) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh()
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [agentId, refresh])
  return { identity, connections, progress, loading, refreshing, error, refresh, setIdentity }
}

// Store only campaign labels, never arbitrary query strings or private values.
try {
  const params = new URLSearchParams(location.search)
  const source = params.get('utm_source')
  const clean = (value: string | null) => value && /^[a-zA-Z0-9_.-]{1,64}$/.test(value) ? value : null
  if (clean(source)) sessionStorage.setItem('pulsar-attribution', JSON.stringify({source: clean(source), medium: clean(params.get('utm_medium')), campaign: clean(params.get('utm_campaign'))}))
} catch { /* storage may be disabled */ }
