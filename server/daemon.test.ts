import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Inspection } from '../src/lib/types'
import { extensionIdFromKey, resolveExtensionId } from './config'
import { createDaemon } from './daemon'
import type { WireBatch } from './batch'

const EXTENSION_ID = 'a'.repeat(32)
const png = 'data:image/png;base64,' + Buffer.from('png-bytes').toString('base64')

const inspection: Inspection = {
  selector: 'button', tag: 'button', html: '<button>Save</button>', htmlTruncated: false, text: 'Save',
  box: { x: 1, y: 2, w: 3, h: 4 }, styles: { color: 'red' }, attributes: {}, ancestors: [],
  viewport: { width: 800, height: 600, dpr: 2 }, react: null,
}

function batchOf(file: string, url = 'http://localhost:3000/settings'): WireBatch {
  return {
    origin: 'http://localhost:3000',
    createdAt: new Date(2026, 9, 27, 14, 5).getTime(),
    pages: [{ path: '/settings', url, viewport: png }],
    pins: [1, 2, 3].map(n => ({
      n, id: `p${n}`, path: '/settings', url, note: `note ${n}`, createdAt: 1, inspection,
      elementSite: { file, line: 4, column: 2 }, callSites: [], crop: png,
    })),
  }
}

let dir: string
let project: string
let home: string
let daemon: Awaited<ReturnType<typeof createDaemon>>

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'daemon-')))
  project = join(dir, 'app')
  home = join(dir, 'home')
  await mkdir(join(project, 'components'), { recursive: true })
  await writeFile(join(project, 'package.json'), '{}')
  daemon = await createDaemon({ port: 0, home, extensionId: EXTENSION_ID, cwdOfPort: async () => null })
})

afterEach(async () => {
  await daemon.stop()
  await rm(dir, { recursive: true, force: true })
})

function connect(origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${daemon.port}/ws`, { headers: { Origin: origin } })
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('socket refused'))
  })
}

function request(ws: WebSocket, frame: object): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    ws.onmessage = event => resolve(JSON.parse(String(event.data)))
    ws.send(JSON.stringify(frame))
  })
}

const allowed = `chrome-extension://${EXTENSION_ID}`

test('GET /health answers ok', async () => {
  const res = await fetch(`http://localhost:${daemon.port}/health`)
  expect(await res.json()).toEqual({ ok: true })
})

test('a 3-pin batch is written into the project and the reply names folder and prompt', async () => {
  const ws = await connect(allowed)
  const reply = await request(ws, { type: 'batch', reqId: 'r1', ...batchOf(join(project, 'components/a.tsx')) })
  ws.close()
  expect(reply).toEqual({
    type: 'batch-saved', reqId: 'r1', project, folder: '2026-10-27-1405-settings',
    prompt: 'Fix the annotations in .annotations/2026-10-27-1405-settings/',
  })
  const files = await readdir(join(project, '.annotations/2026-10-27-1405-settings'))
  expect(files.sort()).toEqual(['batch.json', 'batch.md', 'pin-1.png', 'pin-2.png', 'pin-3.png', 'viewport-1-settings.png'])
})

test('the level in a batch frame shapes batch.md, and an unknown level falls back to standard', async () => {
  const ws = await connect(allowed)
  const file = join(project, 'components/a.tsx')
  await request(ws, { type: 'batch', reqId: 'r1', ...batchOf(file), level: 'compact' })
  await request(ws, { type: 'batch', reqId: 'r2', ...batchOf(file), level: 'loud' })
  ws.close()
  const read = (folder: string) => readFile(join(project, '.annotations', folder, 'batch.md'), 'utf8')
  const compact = await read('2026-10-27-1405-settings')
  const fallback = await read('2026-10-27-1405-settings-2')
  expect(compact).toContain('1. **button**')
  expect(fallback).toContain('### 1.')
})

test('ping is answered with pong', async () => {
  const ws = await connect(allowed)
  expect(await request(ws, { type: 'ping' })).toEqual({ type: 'pong' })
  ws.close()
})

test.each([['https://evil.example'], ['chrome-extension://' + 'b'.repeat(32)]])('upgrade from %s gets 403', async origin => {
  const res = await fetch(`http://localhost:${daemon.port}/ws`, {
    headers: { Origin: origin, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' },
  })
  expect(res.status).toBe(403)
  await expect(connect(origin)).rejects.toThrow()
  expect(await readdir(project)).not.toContain('.annotations')
})

test('upgrade with no Origin gets 403', async () => {
  const res = await fetch(`http://localhost:${daemon.port}/ws`, {
    headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' },
  })
  expect(res.status).toBe(403)
})

test('a batch whose root cannot be found is refused and nothing is written', async () => {
  const ws = await connect(allowed)
  const reply = await request(ws, { type: 'batch', reqId: 'r2', ...batchOf('src/App.tsx', 'http://localhost:5173/settings') })
  ws.close()
  expect(reply).toEqual({ type: 'error', reqId: 'r2', message: 'project root not found' })
  expect(await readdir(project)).not.toContain('.annotations')
})

test('relative source paths resolve through the cwd of the page port', async () => {
  await daemon.stop()
  daemon = await createDaemon({ port: 0, home, extensionId: EXTENSION_ID, cwdOfPort: async port => (port === 5173 ? join(project, 'components') : null) })
  const ws = await connect(allowed)
  const reply = await request(ws, { type: 'batch', reqId: 'r3', ...batchOf('src/App.tsx', 'http://localhost:5173/settings') })
  ws.close()
  expect(reply).toMatchObject({ type: 'batch-saved', project })
})

test('a malformed frame gets an error reply', async () => {
  const ws = await connect(allowed)
  const reply = await request(ws, { type: 'batch', reqId: 'r4', pins: 'nope' })
  ws.close()
  expect(reply).toEqual({ type: 'error', reqId: 'r4', message: 'invalid batch' })
})

test('extensionIdFromKey maps the sha256 of the key to a-p', () => {
  const key = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC5sTIK99JLo9nJZRok+FRHCm04mjCoNT1bpjM1DCe4btgb78Xzp8S+ewArSmDdOthPgJlYiEiiYYzU5sahj54T5jfnnMtafUUZrd5u4j1yI+e9d49PE/XDO8PrvnTpk/GujIMHWjF7Qa3pNUGpZR/BwntafuYrU+Op5Kp6EK9NSQIDAQAB'
  expect(extensionIdFromKey(key)).toBe('kldbkgbgdhbhpiifdenabjikdfoaoklc')
})

test('the extension id comes from the env first, then the manifest key, else the daemon refuses to start', async () => {
  const manifest = join(dir, 'manifest.json')
  const key = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC5sTIK99JLo9nJZRok+FRHCm04mjCoNT1bpjM1DCe4btgb78Xzp8S+ewArSmDdOthPgJlYiEiiYYzU5sahj54T5jfnnMtafUUZrd5u4j1yI+e9d49PE/XDO8PrvnTpk/GujIMHWjF7Qa3pNUGpZR/BwntafuYrU+Op5Kp6EK9NSQIDAQAB'
  await writeFile(manifest, JSON.stringify({ key }))
  expect(await resolveExtensionId({ env: { ANNOTATE_DOM_EXTENSION_ID: 'envid' }, manifestPath: manifest })).toBe('envid')
  expect(await resolveExtensionId({ env: {}, manifestPath: manifest })).toBe('kldbkgbgdhbhpiifdenabjikdfoaoklc')
  await writeFile(manifest, JSON.stringify({ name: 'no key' }))
  await expect(resolveExtensionId({ env: {}, manifestPath: manifest })).rejects.toThrow('ANNOTATE_DOM_EXTENSION_ID')
})

test('projects.json lists the project after a batch', async () => {
  const ws = await connect(allowed)
  await request(ws, { type: 'batch', reqId: 'r5', ...batchOf(join(project, 'components/a.tsx')) })
  ws.close()
  expect(JSON.parse(await readFile(join(home, 'projects.json'), 'utf8'))).toEqual([project])
})

test('a batch with and without also is accepted, and also is stored with an absolute source path', async () => {
  const file = join(project, 'components/a.tsx')
  const base = batchOf(file)
  const also = [{ selector: 'button.cancel', locator: null, elementSite: { file: 'components/b.tsx', line: 3, column: 1 }, box: { x: 1, y: 2, w: 3, h: 4 } }]
  const withAlso = { ...base, pins: base.pins.map((pin, i) => (i === 0 ? { ...pin, also } : pin)) }
  const ws = await connect(allowed)
  const plain = await request(ws, { type: 'batch', reqId: 'r1', ...base })
  const multi = await request(ws, { type: 'batch', reqId: 'r2', ...withAlso })
  ws.close()
  expect([plain.type, multi.type]).toEqual(['batch-saved', 'batch-saved'])
  const stored = JSON.parse(await readFile(join(project, '.annotations', String(multi.folder), 'batch.json'), 'utf8'))
  expect(stored.pins[0].also).toEqual([{ ...also[0], elementSite: { file: join(project, 'components/b.tsx'), line: 3, column: 1 } }])
  expect(stored.pins[1]).not.toHaveProperty('also')
  expect(await readFile(join(project, '.annotations', String(multi.folder), 'batch.md'), 'utf8')).toContain('- Also:')
})

test('a batch whose also entry is malformed is refused', async () => {
  const base = batchOf(join(project, 'components/a.tsx'))
  const bad = { ...base, pins: base.pins.map(pin => ({ ...pin, also: [{ selector: 'x' }] })) }
  const ws = await connect(allowed)
  const reply = await request(ws, { type: 'batch', reqId: 'r1', ...bad })
  ws.close()
  expect(reply).toEqual({ type: 'error', reqId: 'r1', message: 'invalid batch' })
})
