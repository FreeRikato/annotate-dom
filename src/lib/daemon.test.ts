import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import manifest from '../../public/manifest.json'
import {
  createDaemonClient, FIRST_RETRY_MS, MAX_RETRY_MS, PING_MS, SEND_TIMEOUT_MS, sendLabel,
  type SocketHandlers, type SocketLike,
} from './daemon'

class FakeSocket implements SocketLike {
  sent: unknown[] = []
  readonly handlers: SocketHandlers
  constructor(handlers: SocketHandlers) {
    this.handlers = handlers
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.handlers.onClose()
  }
  reply(frame: object) {
    this.handlers.onMessage(JSON.stringify(frame))
  }
}

function setup() {
  const sockets: FakeSocket[] = []
  const client = createDaemonClient({
    createSocket: handlers => {
      const socket = new FakeSocket(handlers)
      sockets.push(socket)
      return socket
    },
  })
  client.start()
  return { client, sockets, latest: () => sockets[sockets.length - 1]! }
}

function reqIdOf(frame: unknown): string {
  if (typeof frame === 'object' && frame !== null && 'reqId' in frame && typeof frame.reqId === 'string') return frame.reqId
  throw new Error('frame has no reqId')
}

const batch = { origin: 'http://localhost:3000', createdAt: 1, pages: [], pins: [] }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('send', () => {
  it('writes one batch frame and resolves on batch-saved', async () => {
    const { client, latest } = setup()
    latest().handlers.onOpen()
    const saved = client.send(batch)
    const [frame] = latest().sent
    expect(frame).toMatchObject({ type: 'batch', origin: 'http://localhost:3000', createdAt: 1 })
    const reqId = reqIdOf(frame)
    latest().reply({ type: 'batch-saved', reqId: 'someone-else', project: 'x', folder: 'x', prompt: 'x' })
    latest().reply({ type: 'batch-saved', reqId, project: '/x/app', folder: '2026-10-27-1200-home', prompt: 'Fix the annotations in .annotations/2026-10-27-1200-home/' })
    await expect(saved).resolves.toEqual({
      project: '/x/app', folder: '2026-10-27-1200-home', prompt: 'Fix the annotations in .annotations/2026-10-27-1200-home/',
    })
  })

  it('rejects with the daemon message on error', async () => {
    const { client, latest } = setup()
    latest().handlers.onOpen()
    const saved = client.send(batch)
    latest().reply({ type: 'error', reqId: reqIdOf(latest().sent[0]), message: 'project root not found' })
    await expect(saved).rejects.toThrow('project root not found')
  })

  it('rejects after the timeout when the daemon never answers', async () => {
    const { client, latest } = setup()
    latest().handlers.onOpen()
    const saved = client.send(batch)
    const outcome = expect(saved).rejects.toThrow('Timed out waiting for the daemon')
    vi.advanceTimersByTime(SEND_TIMEOUT_MS)
    await outcome
  })

  it('rejects when not connected and when the socket drops mid-send', async () => {
    const { client, latest } = setup()
    await expect(client.send(batch)).rejects.toThrow('Daemon not connected')
    latest().handlers.onOpen()
    const saved = client.send(batch)
    latest().close()
    await expect(saved).rejects.toThrow('Daemon disconnected')
  })
})

describe('reconnect and status', () => {
  it('reconnects with backoff capped at 5 s and resets after opening', () => {
    const { sockets, latest } = setup()
    const delays = [FIRST_RETRY_MS, FIRST_RETRY_MS * 2, FIRST_RETRY_MS * 4, FIRST_RETRY_MS * 8, FIRST_RETRY_MS * 16, MAX_RETRY_MS, MAX_RETRY_MS]
    delays.forEach((delay, i) => {
      latest().close()
      vi.advanceTimersByTime(delay - 1)
      expect(sockets).toHaveLength(i + 1)
      vi.advanceTimersByTime(1)
      expect(sockets).toHaveLength(i + 2)
    })
    latest().handlers.onOpen()
    latest().close()
    vi.advanceTimersByTime(FIRST_RETRY_MS)
    expect(sockets).toHaveLength(delays.length + 2)
  })

  it('pings every 20 s while open and stops after close', () => {
    const { latest } = setup()
    const first = latest()
    first.handlers.onOpen()
    vi.advanceTimersByTime(PING_MS * 2)
    expect(first.sent).toEqual([{ type: 'ping' }, { type: 'ping' }])
    first.close()
    vi.advanceTimersByTime(PING_MS * 2)
    expect(first.sent).toHaveLength(2)
  })

  it('tells listeners about connect and disconnect, and the button follows', () => {
    const { client, latest } = setup()
    const labels: string[] = []
    client.onStatus(connected => labels.push(sendLabel(connected)))
    expect(sendLabel(client.isConnected())).toBe('Copy all')
    latest().handlers.onOpen()
    latest().handlers.onOpen()
    expect(client.isConnected()).toBe(true)
    latest().close()
    expect(client.isConnected()).toBe(false)
    expect(labels).toEqual(['Send', 'Copy all'])
  })
})

describe('manifest key', () => {
  async function extensionId(key: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(atob(key), c => c.charCodeAt(0))))
    return [...digest.subarray(0, 16)].flatMap(b => [b >> 4, b & 15]).map(n => String.fromCharCode(97 + n)).join('')
  }

  it('yields the same 32-letter id on every load', async () => {
    const first = await extensionId(manifest.key)
    expect(await extensionId(manifest.key)).toBe(first)
    expect(first).toMatch(/^[a-p]{32}$/)
    expect(first).toBe('ccapopgckfhbcejibalobjclcaodjeed')
  })
})
