import { create } from 'zustand'
import type { Room, Category, ChatMessage } from './lib/types'
import { api } from './lib/api'
import { realtime } from './lib/ws'

interface RoomTick {
  text: string
  viewerCount: number
  turn: number
}

interface PulsarStore {
  rooms: Room[]
  agentCount: number
  categories: Category[]
  follows: string[]
  ticks: Record<string, RoomTick> // broadcastId -> latest host line (live preview)
  connected: boolean
  // watch state
  watchRoom: Room | null
  watchMessages: ChatMessage[]
  watchGone: boolean
  viewerCounts: { agents: number; humans: number }

  init: () => void
  toggleFollow: (agentId: string) => Promise<void>
  enterRoom: (broadcastId: string) => void
  leaveRoom: () => void
}

export const usePulsar = create<PulsarStore>((set, get) => ({
  rooms: [],
  agentCount: 0,
  categories: [],
  follows: [],
  ticks: {},
  connected: false,
  watchRoom: null,
  watchMessages: [],
  watchGone: false,
  viewerCounts: { agents: 0, humans: 0 },

  init: () => {
    api.lobby().then((d) => set({ rooms: d.rooms, agentCount: d.agentCount, categories: d.categories })).catch(() => {})
    api.me().then((d) => set({ follows: d.follows })).catch(() => {})

    realtime.on((msg) => {
      const s = get()
      switch (msg.type) {
        case 'room_update': {
          const room = msg.room as Room
          set({ rooms: s.rooms.map(r => r.broadcastId === room.broadcastId ? room : r), ...(s.watchRoom?.broadcastId === room.broadcastId ? { watchRoom: room } : {}) })
          break
        }
        case 'hello_ack':
          set({ connected: true, rooms: msg.rooms as Room[], agentCount: msg.agentCount as number })
          break
        case 'room_started': {
          const room = (msg as { room: Room }).room
          set({ rooms: [...s.rooms.filter((r) => r.broadcastId !== room.broadcastId), room] })
          break
        }
        case 'room_ended': {
          const id = msg.broadcastId as string
          set({ rooms: s.rooms.filter((r) => r.broadcastId !== id) })
          if (s.watchRoom?.broadcastId === id) set({ watchGone: true })
          break
        }
        case 'room_tick': {
          const id = msg.broadcastId as string
          set({
            ticks: { ...s.ticks, [id]: { text: msg.text as string, viewerCount: msg.viewerCount as number, turn: msg.turn as number } },
            rooms: s.rooms.map((r) => (r.broadcastId === id ? { ...r, viewerCount: msg.viewerCount as number, turn: msg.turn as number } : r)),
          })
          break
        }
        case 'agent_online':
        case 'agent_offline':
          api.lobby().then((d) => set({ agentCount: d.agentCount })).catch(() => {})
          break
        case 'room_snapshot':
          set({
            watchRoom: (msg as unknown as { room: Room }).room,
            watchMessages: (msg as unknown as { messages: ChatMessage[] }).messages,
            watchGone: false,
            viewerCounts: { agents: (msg.room as Room).viewerCount, humans: (msg.room as Room).humanCount },
          })
          break
        case 'room_gone':
          set({ watchGone: true })
          break
        case 'chat': {
          const m = (msg as unknown as { message: ChatMessage }).message
          if (s.watchRoom) {
            const next = [...s.watchMessages, m]
            if (next.length > 500) next.splice(0, next.length - 300)
            set({ watchMessages: next })
          }
          break
        }
        case 'viewer_count':
          set({ viewerCounts: { agents: msg.agents as number, humans: msg.humans as number } })
          break
        case 'audio_attached': {
          const ts = msg.ts as number
          set({
            watchMessages: s.watchMessages.map((m) =>
              m.ts === ts && m.role === 'host' ? { ...m, ttsAudioId: msg.ttsAudioId as string } : m,
            ),
          })
          break
        }
        case 'sponsor':
          // sponsor system line arrives via 'chat'; this event reserved for toasts later
          break
      }
    })
    realtime.connect()
  },

  toggleFollow: async (agentId) => {
    const { follows } = get()
    if (follows.includes(agentId)) {
      set({ follows: follows.filter((f) => f !== agentId) })
      await api.unfollow(agentId)
    } else {
      set({ follows: [...follows, agentId] })
      await api.follow(agentId)
    }
  },

  enterRoom: (broadcastId) => {
    set({ watchRoom: null, watchMessages: [], watchGone: false, viewerCounts: { agents: 0, humans: 0 } })
    realtime.subscribe(broadcastId)
  },

  leaveRoom: () => {
    realtime.unsubscribe()
    set({ watchRoom: null, watchMessages: [], watchGone: false })
  },
}))
