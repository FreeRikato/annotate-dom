import type { Pin } from './types'

export const DAEMON_URL = 'ws://localhost:4747/ws'
export const PING_MS = 20_000
export const FIRST_RETRY_MS = 250
export const MAX_RETRY_MS = 5_000
export const SEND_TIMEOUT_MS = 30_000

export type BatchFrame = {
  readonly type: 'batch'
  readonly reqId: string
  readonly origin: string
  readonly createdAt: number
  readonly pages: readonly { readonly path: string; readonly url: string; readonly viewport: string | null }[]
  readonly pins: readonly (Pin & { readonly n: number })[]
}

export type SavedBatch = { readonly project: string; readonly folder: string; readonly prompt: string }

type ServerFrame =
  | ({ readonly type: 'batch-saved'; readonly reqId: string } & SavedBatch)
  | { readonly type: 'error'; readonly reqId: string; readonly message: string }
  | { readonly type: 'pong' }

export type SocketHandlers = {
  readonly onOpen: () => void
  readonly onClose: () => void
  readonly onMessage: (data: unknown) => void
}

export type SocketLike = { readonly send: (data: string) => void; readonly close: () => void }

export type SocketFactory = (handlers: SocketHandlers) => SocketLike

export function webSocketFactory(url: string): SocketFactory {
  return ({ onOpen, onClose, onMessage }) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', onOpen)
    ws.addEventListener('close', onClose)
    ws.addEventListener('message', event => onMessage(event.data))
    return { send: data => ws.send(data), close: () => ws.close() }
  }
}

export function sendLabel(connected: boolean): string {
  return connected ? 'Send' : 'Copy all'
}

function parseFrame(data: unknown): ServerFrame | null {
  if (typeof data !== 'string') return null
  let frame: unknown
  try {
    frame = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof frame !== 'object' || frame === null || !('type' in frame)) return null
  if (frame.type === 'pong') return { type: 'pong' }
  if (!('reqId' in frame) || typeof frame.reqId !== 'string') return null
  if (frame.type === 'error' && 'message' in frame && typeof frame.message === 'string') {
    return { type: 'error', reqId: frame.reqId, message: frame.message }
  }
  if (
    frame.type === 'batch-saved' && 'project' in frame && typeof frame.project === 'string' &&
    'folder' in frame && typeof frame.folder === 'string' && 'prompt' in frame && typeof frame.prompt === 'string'
  ) {
    return { type: 'batch-saved', reqId: frame.reqId, project: frame.project, folder: frame.folder, prompt: frame.prompt }
  }
  return null
}

type Pending = {
  readonly resolve: (saved: SavedBatch) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export function createDaemonClient({ createSocket }: { readonly createSocket: SocketFactory }) {
  const pending = new Map<string, Pending>()
  const listeners = new Set<(connected: boolean) => void>()
  let socket: SocketLike | null = null
  let connected = false
  let attempt = 0
  let pingTimer: ReturnType<typeof setInterval> | undefined

  function setConnected(next: boolean) {
    if (connected === next) return
    connected = next
    for (const listener of listeners) listener(next)
  }

  function settle(reqId: string, finish: (entry: Pending) => void) {
    const entry = pending.get(reqId)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(reqId)
    finish(entry)
  }

  function connect() {
    const current = createSocket({
      onOpen() {
        attempt = 0
        pingTimer = setInterval(() => current.send(JSON.stringify({ type: 'ping' })), PING_MS)
        setConnected(true)
      },
      onClose() {
        clearInterval(pingTimer)
        socket = null
        setConnected(false)
        for (const reqId of [...pending.keys()]) settle(reqId, entry => entry.reject(new Error('Daemon disconnected')))
        setTimeout(connect, Math.min(FIRST_RETRY_MS * 2 ** attempt, MAX_RETRY_MS))
        attempt += 1
      },
      onMessage(data) {
        const frame = parseFrame(data)
        if (frame?.type === 'batch-saved') settle(frame.reqId, entry => entry.resolve({ project: frame.project, folder: frame.folder, prompt: frame.prompt }))
        else if (frame?.type === 'error') settle(frame.reqId, entry => entry.reject(new Error(frame.message)))
      },
    })
    socket = current
  }

  return {
    start: connect,
    isConnected: () => connected,
    onStatus(listener: (connected: boolean) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    send(batch: Omit<BatchFrame, 'type' | 'reqId'>): Promise<SavedBatch> {
      if (!connected || !socket) return Promise.reject(new Error('Daemon not connected'))
      const reqId = crypto.randomUUID()
      const frame: BatchFrame = { type: 'batch', reqId, ...batch }
      const target = socket
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => settle(reqId, entry => entry.reject(new Error('Timed out waiting for the daemon'))),
          SEND_TIMEOUT_MS,
        )
        pending.set(reqId, { resolve, reject, timer })
        try {
          target.send(JSON.stringify(frame))
        } catch (err: unknown) {
          settle(reqId, entry => entry.reject(err instanceof Error ? err : new Error(String(err))))
        }
      })
    },
  }
}
