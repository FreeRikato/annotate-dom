import { type WireBatch, writeBatch } from './batch'
import { handleMcp } from './mcp'
import { cwdOfListeningPort, findProjectRoot } from './root'

export type DaemonOptions = {
  readonly port: number
  readonly home: string
  readonly extensionId: string
  readonly cwdOfPort?: (port: number) => Promise<string | null>
}

export type Daemon = { readonly port: number; readonly stop: () => Promise<void> }

type BatchFrame = { readonly reqId: string; readonly batch: WireBatch }

const MAX_FRAME_BYTES = 256 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isWirePage(value: unknown): value is WireBatch['pages'][number] {
  return isRecord(value) && typeof value.path === 'string' && typeof value.url === 'string'
    && (value.viewport === null || typeof value.viewport === 'string')
}

function isWirePin(value: unknown): value is WireBatch['pins'][number] {
  return isRecord(value) && typeof value.n === 'number' && typeof value.url === 'string'
    && typeof value.path === 'string' && typeof value.note === 'string' && typeof value.crop === 'string'
    && isRecord(value.inspection) && Array.isArray(value.callSites)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function parseBatchFrame(frame: Record<string, unknown>): BatchFrame | null {
  const { reqId, origin, createdAt, pages, pins } = frame
  if (typeof reqId !== 'string' || typeof origin !== 'string' || typeof createdAt !== 'number') return null
  if (!Array.isArray(pages) || !pages.every(isWirePage) || !Array.isArray(pins) || !pins.every(isWirePin)) return null
  return { reqId, batch: { origin, createdAt, pages, pins } }
}

function sourceFiles(batch: WireBatch): string[] {
  return batch.pins.flatMap(pin => [pin.elementSite?.file, ...pin.callSites.map(s => s.loc?.file)])
    .filter((file): file is string => typeof file === 'string')
}

export async function createDaemon({ port, home, extensionId, cwdOfPort = cwdOfListeningPort }: DaemonOptions): Promise<Daemon> {
  const allowedOrigin = `chrome-extension://${extensionId}`
  let queue: Promise<unknown> = Promise.resolve()
  let boundPort = port

  async function save({ reqId, batch }: BatchFrame): Promise<object> {
    const root = await findProjectRoot({ sourceFiles: sourceFiles(batch), pageUrls: batch.pages.map(p => p.url), cwdOfPort })
    if (!root) return { type: 'error', reqId, message: 'project root not found' }
    const { folder, prompt } = await writeBatch({ root, home, batch })
    return { type: 'batch-saved', reqId, project: root, folder, prompt }
  }

  const server = Bun.serve({
    port,
    hostname: 'localhost',
    fetch(req, srv) {
      const { pathname } = new URL(req.url)
      if (pathname === '/health') return Response.json({ ok: true })
      if (pathname === '/ws') {
        if (req.headers.get('origin') !== allowedOrigin) return new Response('forbidden', { status: 403 })
        return srv.upgrade(req) ? undefined : new Response('upgrade failed', { status: 400 })
      }
      if (pathname === '/mcp') return handleMcp({ req, home, port: srv.port as number })
      return new Response('not found', { status: 404 })
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES,
      message(ws, raw) {
        const frame = parseJson(String(raw))
        if (!isRecord(frame)) return
        if (frame.type === 'ping') return void ws.send(JSON.stringify({ type: 'pong' }))
        if (frame.type !== 'batch') return
        const parsed = parseBatchFrame(frame)
        const reqId = typeof frame.reqId === 'string' ? frame.reqId : ''
        if (!parsed) return void ws.send(JSON.stringify({ type: 'error', reqId, message: 'invalid batch' }))
        queue = queue
          .then(() => save(parsed))
          .catch((err: unknown) => ({ type: 'error', reqId, message: err instanceof Error ? err.message : String(err) }))
          .then(reply => ws.send(JSON.stringify(reply)))
      },
    },
  })

  boundPort = server.port ?? port

  return { port: boundPort, stop: () => server.stop(true) }
}
