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
const png = 'data:image/png;base64,' + Buffer.from('png-bytes').toString('base64')

const inspection: Inspection = {
  selector: 'button', tag: 'button', html: '<button>Save</button>', htmlTruncated: false, text: 'Save',
  box: { x: 1, y: 2, w: 3, h: 4 }, styles: {}, attributes: {}, ancestors: [],
  viewport: { width: 800, height: 600, dpr: 2 }, react: null,
}

function batchOf(file: string, minute: number, notes: string[]): WireBatch {
  const url = 'http://localhost:3000/settings'
  return {
    origin: 'http://localhost:3000',
    createdAt: new Date(2026, 9, 27, 14, minute).getTime(),
    pages: [{ path: '/settings', url, viewport: png }],
    pins: notes.map((note, i) => ({
      n: i + 1, id: `p${i}`, path: '/settings', url, note, createdAt: 1, inspection,
      elementSite: { file, line: 4, column: 2 }, callSites: [], crop: png,
    })),
  }
}

let dir: string
let home: string
let appA: string
let appB: string
let daemon: Awaited<ReturnType<typeof createDaemon>>
let client: Client

async function sendBatch(batch: WireBatch): Promise<void> {
  const ws = new WebSocket(`ws://localhost:${daemon.port}/ws`, { headers: { Origin: `chrome-extension://${EXTENSION_ID}` } })
  await new Promise(resolve => { ws.onopen = resolve })
  const reply = new Promise<Record<string, unknown>>(resolve => { ws.onmessage = e => resolve(JSON.parse(String(e.data))) })
  ws.send(JSON.stringify({ type: 'batch', reqId: 'r', ...batch }))
  expect((await reply).type).toBe('batch-saved')
  ws.close()
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  const first = Array.isArray(result.content) ? result.content[0] : undefined
  const text = first && 'text' in first ? String(first.text) : ''
  return { isError: result.isError === true, text }
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'mcp-')))
  home = join(dir, 'home')
  appA = join(dir, 'a')
  appB = join(dir, 'b')
  for (const app of [appA, appB]) {
    await mkdir(join(app, 'src'), { recursive: true })
    await writeFile(join(app, 'package.json'), '{}')
  }
  daemon = await createDaemon({ port: 0, home, extensionId: EXTENSION_ID, cwdOfPort: async () => null })
  await sendBatch(batchOf(join(appA, 'src/x.tsx'), 5, ['old one']))
  await sendBatch(batchOf(join(appA, 'src/x.tsx'), 9, ['new one', 'new two']))
  await sendBatch(batchOf(join(appB, 'src/y.tsx'), 7, ['b one']))
  client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${daemon.port}/mcp`)))
})

afterEach(async () => {
  await client.close()
  await daemon.stop()
  await rm(dir, { recursive: true, force: true })
})

test('the server offers list, get, resolve and recapture and tells the agent to pass its working directory', async () => {
  const { tools } = await client.listTools()
  expect(tools.map(t => t.name).sort()).toEqual(['get_annotation', 'list_annotations', 'recapture', 'resolve_annotation'])
  for (const tool of tools) expect(tool.description).toContain('working directory')
})

test('list with a project inside appA returns only appA open pins, newest batch first', async () => {
  const { text } = await call('list_annotations', { project: join(appA, 'src') })
  const pins: { id: string; note: string; path: string; project: string; elementSite: { file: string } }[] = JSON.parse(text)
  expect(pins.map(p => [p.id, p.note])).toEqual([
    ['2026-10-27-1409-settings#1', 'new one'], ['2026-10-27-1409-settings#2', 'new two'], ['2026-10-27-1405-settings#1', 'old one'],
  ])
  expect(pins[0]?.path).toBe('/settings')
  expect(pins[0]?.elementSite.file).toBe(join(appA, 'src/x.tsx'))
})

test('list without a project returns every known project, each tagged with its root', async () => {
  const { text } = await call('list_annotations', {})
  const pins: { note: string; project: string }[] = JSON.parse(text)
  expect(pins.map(p => [p.note, p.project])).toEqual([
    ['new one', appA], ['new two', appA], ['b one', appB], ['old one', appA],
  ])
})

test('get returns the full pin with absolute png paths, and an unknown id is a tool error', async () => {
  const found = await call('get_annotation', { id: '2026-10-27-1409-settings#2' })
  expect(JSON.parse(found.text)).toMatchObject({
    note: 'new two', cropFile: join(appA, '.annotations/2026-10-27-1409-settings/pin-2.png'), status: 'open',
  })
  const missing = await call('get_annotation', { id: 'nope#1' })
  expect(missing).toEqual({ isError: true, text: 'annotation not found: nope#1' })
})

test('resolve updates only that pin and the default list drops it', async () => {
  const id = '2026-10-27-1409-settings#1'
  const folder = join(appA, '.annotations/2026-10-27-1409-settings')
  const filesBefore = await readdir(folder)
  const resolved = await call('resolve_annotation', { id, summary: 'Disabled Save while invalid', project: appA })
  expect(resolved.isError).toBe(false)
  const saved: StoredBatch = JSON.parse(await readFile(join(folder, 'batch.json'), 'utf8'))
  expect(saved.pins.map(p => p.status)).toEqual(['resolved', 'open'])
  expect(saved.pins[0]).toMatchObject({ summary: 'Disabled Save while invalid' })
  expect(typeof saved.pins[0]?.resolvedAt).toBe('number')
  expect(saved.pins[1]).toMatchObject({ summary: null, resolvedAt: null })
  expect(await readdir(folder)).toEqual(filesBefore)
  const open: { id: string }[] = JSON.parse((await call('list_annotations', { project: appA })).text)
  expect(open.map(p => p.id)).not.toContain(id)
  expect((await call('resolve_annotation', { id: 'nope#1', summary: 'x' })).text).toBe('annotation not found: nope#1')
})

test('an id present in two projects is a tool error naming both until a project is passed', async () => {
  await sendBatch(batchOf(join(appB, 'src/y.tsx'), 9, ['b clash']))
  const id = '2026-10-27-1409-settings#1'
  for (const [name, args] of [['get_annotation', { id }], ['resolve_annotation', { id, summary: 'x' }], ['recapture', { id }]] as const) {
    const result = await call(name, args)
    expect(result.isError).toBe(true)
    expect(result.text).toContain(`annotation id ${id} exists in several projects`)
    expect(result.text).toContain(appA)
    expect(result.text).toContain(appB)
  }
  expect((await call('resolve_annotation', { id, summary: 'x', project: appB })).isError).toBe(false)
  const stillOpenInA: { note: string }[] = JSON.parse((await call('list_annotations', { project: appA })).text)
  expect(stillOpenInA.map(p => p.note)).toContain('new one')
})

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }

function post(headers: Record<string, string>): Promise<Response> {
  return fetch(`http://localhost:${daemon.port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(initialize),
  })
}

test('a foreign Host or any Origin gets 403, a localhost Host without Origin is served', async () => {
  expect((await post({ Host: `evil.example:${daemon.port}` })).status).toBe(403)
  expect((await post({ Host: `localhost:${daemon.port + 1}` })).status).toBe(403)
  expect((await post({ Origin: 'http://localhost:3000' })).status).toBe(403)
  expect((await post({ Origin: 'null' })).status).toBe(403)
  expect((await post({ Host: `127.0.0.1:${daemon.port}` })).status).toBe(200)
  expect((await post({})).status).toBe(200)
})
