import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Inspection } from '../src/lib/types'
import type { StoredBatch, WireBatch } from './batch'
import { createDaemon } from './daemon'

const EXTENSION_ID = 'a'.repeat(32)
const png = (text: string) => 'data:image/png;base64,' + Buffer.from(text).toString('base64')
const ID = '2026-10-27-1405-settings#1'

const before: Inspection = {
  selector: '#theme', tag: 'button', html: '<button id="theme">Dark</button>', htmlTruncated: false, text: 'Dark',
  box: { x: 1, y: 2, w: 3, h: 4 }, styles: { 'padding-right': '24px', color: 'red' }, attributes: {}, ancestors: [],
  viewport: { width: 800, height: 600, dpr: 2 }, react: null, locator: "getByRole('button', { name: 'Dark' })",
}

let dir: string
let home: string
let app: string
let daemon: Awaited<ReturnType<typeof createDaemon>>
let client: Client
let extension: WebSocket | null

async function connectExtension(onRecapture: (frame: Record<string, unknown>, reply: (body: object) => void) => void): Promise<void> {
  extension = new WebSocket(`ws://localhost:${daemon.port}/ws`, { headers: { Origin: `chrome-extension://${EXTENSION_ID}` } })
  const socket = extension
  await new Promise(resolve => { socket.onopen = resolve })
  socket.onmessage = e => {
    const frame = JSON.parse(String(e.data))
    if (frame.type === 'recapture') onRecapture(frame, body => socket.send(JSON.stringify({ type: 'recapture-result', reqId: frame.reqId, ...body })))
  }
}

async function recapture(args: Record<string, unknown>) {
  const result = await client.callTool({ name: 'recapture', arguments: args })
  const first = Array.isArray(result.content) ? result.content[0] : undefined
  return { isError: result.isError === true, text: first && 'text' in first ? String(first.text) : '' }
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'recapture-')))
  home = join(dir, 'home')
  app = join(dir, 'app')
  await mkdir(join(app, 'src'), { recursive: true })
  await writeFile(join(app, 'package.json'), '{}')
  daemon = await createDaemon({ port: 0, home, extensionId: EXTENSION_ID, cwdOfPort: async () => null, recaptureTimeoutMs: 200 })
  const url = 'http://localhost:3000/settings'
  const batch: WireBatch = {
    origin: 'http://localhost:3000', createdAt: new Date(2026, 9, 27, 14, 5).getTime(),
    pages: [{ path: '/settings', url, viewport: null }],
    pins: [{
      n: 1, id: 'p', path: '/settings', url, note: 'tighten padding', createdAt: 1, inspection: before,
      elementSite: { file: join(app, 'src/x.tsx'), line: 4, column: 2 }, callSites: [], crop: png('before-bytes'),
    }],
  }
  await connectExtension((_frame, reply) => reply({ ok: false, reason: 'unexpected' }))
  const saved = new Promise<void>(resolve => {
    extension?.addEventListener('message', e => { if (JSON.parse(String(e.data)).type === 'batch-saved') resolve() })
  })
  extension?.send(JSON.stringify({ type: 'batch', reqId: 'r', ...batch }))
  await saved
  client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${daemon.port}/mcp`)))
})

afterEach(async () => {
  await client.close()
  extension?.close()
  await daemon.stop()
  await rm(dir, { recursive: true, force: true })
})

test('success saves the after image, reports the style diff and records the recapture', async () => {
  const requests: Record<string, unknown>[] = []
  await connectExtension((frame, reply) => {
    requests.push(frame)
    reply({
      ok: true, crop: png('after-bytes'),
      inspection: { ...before, styles: { 'padding-right': '16px', color: 'red' } },
    })
  })
  const { isError, text } = await recapture({ id: ID, project: app })
  expect(isError).toBe(false)
  const folder = join(app, '.annotations/2026-10-27-1405-settings')
  expect(JSON.parse(text)).toEqual({
    ok: true, before: join(folder, 'pin-1.png'), after: join(folder, 'pin-1-after.png'),
    styleDiff: [{ prop: 'padding-right', before: '24px', after: '16px' }], htmlChanged: false,
  })
  expect(requests[0]).toMatchObject({ type: 'recapture', url: 'http://localhost:3000/settings', selector: '#theme', locator: before.locator })
  expect(await readFile(join(folder, 'pin-1-after.png'), 'utf8')).toBe('after-bytes')
  const stored: StoredBatch = JSON.parse(await readFile(join(folder, 'batch.json'), 'utf8'))
  expect(stored.pins[0]?.recaptures).toMatchObject([{
    afterFile: 'pin-1-after.png', styleDiff: [{ prop: 'padding-right', before: '24px', after: '16px' }], htmlChanged: false,
  }])
})

test('changed markup is reported as htmlChanged', async () => {
  await connectExtension((_frame, reply) => reply({ ok: true, crop: png('x'), inspection: { ...before, html: '<button id="theme">Light</button>' } }))
  expect(JSON.parse((await recapture({ id: ID })).text)).toMatchObject({ htmlChanged: true, styleDiff: [] })
})

test('element not found is returned and no after image is saved', async () => {
  await connectExtension((_frame, reply) => reply({ ok: false, reason: 'element not found' }))
  expect(await recapture({ id: ID })).toEqual({ isError: true, text: 'element not found' })
  const folder = join(app, '.annotations/2026-10-27-1405-settings')
  expect(await readdir(folder)).not.toContain('pin-1-after.png')
  const stored: StoredBatch = JSON.parse(await readFile(join(folder, 'batch.json'), 'utf8'))
  expect(stored.pins[0]?.recaptures).toEqual([])
})

test('with no extension socket open it says the extension is not connected', async () => {
  extension?.close()
  await Bun.sleep(50)
  expect(await recapture({ id: ID })).toEqual({ isError: true, text: 'extension not connected' })
})

test('an extension that never answers times out', async () => {
  await connectExtension(() => {})
  expect(await recapture({ id: ID })).toEqual({ isError: true, text: 'extension did not respond' })
})

test('an unknown id is a tool error', async () => {
  expect(await recapture({ id: 'nope#1' })).toEqual({ isError: true, text: 'annotation not found: nope#1' })
})

test('closing an older socket does not disconnect the newer one', async () => {
  const older = extension
  await connectExtension((_frame, reply) => reply({ ok: true, crop: png('x'), inspection: before }))
  older?.close()
  await Bun.sleep(50)
  expect(JSON.parse((await recapture({ id: ID })).text)).toMatchObject({ ok: true })
})

test('a failure result without a reason is ignored', async () => {
  await connectExtension((_frame, reply) => reply({ ok: false }))
  expect(await recapture({ id: ID })).toEqual({ isError: true, text: 'extension did not respond' })
})
