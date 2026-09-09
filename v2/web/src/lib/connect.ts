import { useEffect, useState } from 'react'

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
  const [error, setError] = useState('')
  const refresh = async () => {
    try {
      const d = await connectRequest<{
        identity: Identity | null
        connections: Connection[]
      }>('session')
      setIdentity(d.identity)
      setConnections(d.connections)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    let active = true
    connectRequest<{ identity: Identity | null; connections: Connection[] }>(
      'session',
    )
      .then((d) => {
        if (active) {
          setIdentity(d.identity)
          setConnections(d.connections)
        }
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])
  return { identity, connections, loading, error, refresh, setIdentity }
}

// Store only campaign labels, never arbitrary query strings or private values.
try {
  const params = new URLSearchParams(location.search)
  const source = params.get('utm_source')
  const clean = (value: string | null) => value && /^[a-zA-Z0-9_.-]{1,64}$/.test(value) ? value : null
  if (clean(source)) sessionStorage.setItem('pulsar-attribution', JSON.stringify({source: clean(source), medium: clean(params.get('utm_medium')), campaign: clean(params.get('utm_campaign'))}))
} catch { /* storage may be disabled */ }
