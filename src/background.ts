import { axeViolations, inspectElement } from './inspect'
import {
  clearRecaptureTarget, createDaemonClient, createRecaptureHandler, DAEMON_URL, markRecaptureTarget, parseSavedLevel, SETTINGS_KEY, TARGET_ATTR, waitForQuiet, webSocketFactory,
} from './lib/daemon'
import { toMarkdown, type ExportPage } from './lib/markdown'
import { assertNever, hasRequestKind, type Reply, type Request, type Responses } from './lib/messages'
import { emptyBatch, type Batch, type Box, type DetailLevel, type Inspection, type ViewportShot } from './lib/types'

const batchKey = (tabId: number) => `batch:${tabId}`
const undoKey = (tabId: number) => `undo:${tabId}`

function isBatch(value: unknown): value is Batch {
  return typeof value === 'object' && value !== null && 'pins' in value && Array.isArray(value.pins) &&
    'viewports' in value && typeof value.viewports === 'object' && value.viewports !== null
}

async function read(key: string): Promise<Batch | null> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(key)
  const value = stored[key]
  return isBatch(value) ? value : null
}

async function savedLevel(): Promise<DetailLevel> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(SETTINGS_KEY)
  return parseSavedLevel(stored[SETTINGS_KEY]) ?? 'standard'
}

async function writeBatch(tabId: number, batch: Batch): Promise<Batch> {
  await chrome.storage.local.set({ [batchKey(tabId)]: batch })
  await chrome.action.setBadgeText({ tabId, text: batch.pins.length ? String(batch.pins.length) : '' })
  return batch
}

const locks = new Map<number, Promise<unknown>>()

function withTab<T>(tabId: number, work: () => Promise<T>): Promise<T> {
  const next = (locks.get(tabId) ?? Promise.resolve()).then(work, work)
  locks.set(tabId, next.catch(() => undefined))
  return next
}

async function toggle(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
}

async function decode(dataUrl: string): Promise<ImageBitmap> {
  return createImageBitmap(await (await fetch(dataUrl)).blob())
}

async function encode(canvas: OffscreenCanvas): Promise<string> {
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:image/png;base64,${btoa(binary)}`
}

const PIN_COLOR = '#ff3b30'
const PAD = 40

async function crop({ image, rect, scale }: { readonly image: ImageBitmap; readonly rect: Box; readonly scale: number }): Promise<string> {
  const x0 = Math.max(0, Math.floor((rect.x - PAD) * scale))
  const y0 = Math.max(0, Math.floor((rect.y - PAD) * scale))
  const x1 = Math.min(image.width, Math.ceil((rect.x + rect.w + PAD) * scale))
  const y1 = Math.min(image.height, Math.ceil((rect.y + rect.h + PAD) * scale))
  const canvas = new OffscreenCanvas(Math.max(1, x1 - x0), Math.max(1, y1 - y0))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2d context')
  ctx.drawImage(image, x0, y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = PIN_COLOR
  ctx.lineWidth = 2 * scale
  ctx.strokeRect(rect.x * scale - x0, rect.y * scale - y0, rect.w * scale, rect.h * scale)
  return encode(canvas)
}

async function numberedViewport({ shot, numbers }: { readonly shot: ViewportShot; readonly numbers: ReadonlyMap<string, number> }): Promise<string> {
  const image = await decode(shot.image)
  const canvas = new OffscreenCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2d context')
  ctx.drawImage(image, 0, 0)
  const s = shot.dpr
  for (const [id, box] of Object.entries(shot.rects)) {
    const n = numbers.get(id)
    if (n === undefined) continue
    ctx.strokeStyle = PIN_COLOR
    ctx.lineWidth = 2 * s
    ctx.strokeRect(box.x * s, box.y * s, box.w * s, box.h * s)
    const r = 11 * s
    const cx = Math.max(r, box.x * s)
    const cy = Math.max(r, box.y * s)
    ctx.fillStyle = PIN_COLOR
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = `bold ${12 * s}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(n), cx, cy)
  }
  return encode(canvas)
}

function waitForDownload(id: number): Promise<void> {
  return new Promise(resolve => {
    const done = (item?: chrome.downloads.DownloadItem) => {
      if (item && item.state === 'in_progress') return false
      chrome.downloads.onChanged.removeListener(listener)
      resolve()
      return true
    }
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === id && delta.state && delta.state.current !== 'in_progress') done()
    }
    chrome.downloads.onChanged.addListener(listener)
    chrome.downloads.search({ id }).then(([item]) => done(item), () => done())
  })
}

async function download({ url, filename }: { readonly url: string; readonly filename: string }): Promise<string | null> {
  try {
    const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false })
    await waitForDownload(id)
    const [item] = await chrome.downloads.search({ id })
    return item?.state === 'complete' ? item.filename : null
  } catch {
    return null
  }
}

function fileStamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function slug(path: string): string {
  return path.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 60) || 'root'
}

async function exportBatch({ tabId, origin }: { readonly tabId: number; readonly origin: string }): Promise<Responses['export']> {
  const batch = (await read(batchKey(tabId))) ?? emptyBatch
  const now = Date.now()
  const prefix = `annotate-dom/${fileStamp(now)}`
  const paths = [...new Set(batch.pins.map(p => p.path))]
  const pages: ExportPage[] = []
  let n = 0
  for (const [pageIndex, path] of paths.entries()) {
    const numbers = new Map<string, number>()
    const pins = []
    for (const pin of batch.pins.filter(p => p.path === path)) {
      n += 1
      numbers.set(pin.id, n)
      pins.push({ pin, cropFile: await download({ url: pin.crop, filename: `${prefix}-${slug(path)}-${n}.png` }) })
    }
    const shot = batch.viewports[path]
    const viewportFile = shot
      ? await download({ url: await numberedViewport({ shot, numbers }), filename: `${prefix}-${pageIndex + 1}-${slug(path)}-viewport.png` })
      : null
    pages.push({ path, url: pins[0]?.pin.url ?? origin + path, viewportFile, pins })
  }
  const markdown = toMarkdown({ origin, createdAt: now, pages, level: await savedLevel() })
  await chrome.storage.local.set({ [undoKey(tabId)]: batch })
  await writeBatch(tabId, emptyBatch)
  return { markdown, count: n }
}

async function sendBatch({ tabId, origin }: { readonly tabId: number; readonly origin: string }): Promise<Responses['send']> {
  const batch = (await read(batchKey(tabId))) ?? emptyBatch
  const pages = []
  const pins = []
  for (const path of new Set(batch.pins.map(p => p.path))) {
    const numbers = new Map<string, number>()
    for (const pin of batch.pins.filter(p => p.path === path)) {
      numbers.set(pin.id, pins.length + 1)
      pins.push({ ...pin, n: pins.length + 1 })
    }
    const shot = batch.viewports[path]
    pages.push({
      path,
      url: batch.pins.find(p => p.path === path)?.url ?? origin + path,
      viewport: shot ? await numberedViewport({ shot, numbers }) : null,
    })
  }
  const saved = await daemon.send({ origin, createdAt: Date.now(), pages, pins, level: await savedLevel() })
  await writeBatch(tabId, emptyBatch)
  return { count: pins.length, folder: saved.folder, prompt: saved.prompt }
}

async function inspectTab({ tabId, frameId, marker }: { readonly tabId: number; readonly frameId: number; readonly marker: string }): Promise<Inspection | null> {
  const target = { tabId, frameIds: [frameId] }
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: () => Reflect.has(window, 'axe'),
  })
  const withoutAxe = frames.filter(frame => !frame.result).map(frame => frame.frameId)
  if (withoutAxe.length) await chrome.scripting.executeScript({ target: { tabId, frameIds: withoutAxe }, world: 'MAIN', files: ['axe.min.js'] })
  const [result] = await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    func: inspectElement,
    args: [marker],
  })
  const inspection = result?.result
  if (!inspection?.a11y) return inspection ?? null
  const [found] = await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    func: axeViolations,
    args: [marker],
  })
  return { ...inspection, a11y: { ...inspection.a11y, violations: found?.result ?? [] } }
}

const QUIET_MS = 1_000
const SETTLE_CAP_MS = 10_000
const CDP_VERSION = '1.3'

function onTabLoaded(tabId: number): Promise<void> {
  return new Promise(resolve => {
    const listener = (id: number, info: { status?: string }) => {
      if (id !== tabId || info.status !== 'complete') return
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

const CAPTURE_QUOTA_WAIT_MS = 250
const CAPTURE_QUOTA_RETRIES = 6

export async function captureVisible(windowId: number): Promise<string> {
  for (let retries = 0; ; retries++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
    } catch (err: unknown) {
      const refused = err instanceof Error && err.message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')
      if (!refused || retries >= CAPTURE_QUOTA_RETRIES) throw err
      await new Promise(resolve => setTimeout(resolve, CAPTURE_QUOTA_WAIT_MS))
    }
  }
}

async function captureTab(tabId: number): Promise<string> {
  const target = { tabId }
  await chrome.debugger.attach(target, CDP_VERSION)
  try {
    const shot: unknown = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'png' })
    if (typeof shot !== 'object' || shot === null || !('data' in shot) || typeof shot.data !== 'string') throw new Error('Screenshot failed')
    return `data:image/png;base64,${shot.data}`
  } finally {
    await chrome.debugger.detach(target).catch(() => undefined)
  }
}

const recapture = createRecaptureHandler({
  findTab: async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id ?? null,
  openTab: async url => {
    const tab = await chrome.tabs.create({ url, active: false })
    if (tab.id === undefined) throw new Error('Could not open a tab')
    await onTabLoaded(tab.id)
    return tab.id
  },
  closeTab: tabId => chrome.tabs.remove(tabId),
  settle: async tabId => void await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: waitForQuiet,
    args: [{ quietMs: QUIET_MS, capMs: SETTLE_CAP_MS }],
  }),
  mark: async ({ tabId, selector, locator, marker }) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: markRecaptureTarget,
      args: [{ selector, locator, marker, attr: TARGET_ATTR }],
    })
    return result?.result ?? null
  },
  unmark: async ({ tabId, marker }) => void await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: clearRecaptureTarget,
    args: [{ marker, attr: TARGET_ATTR }],
  }),
  inspect: ({ tabId, marker }) => inspectTab({ tabId, frameId: 0, marker }),
  screenshot: captureTab,
  crop: async ({ shot, box, viewportWidth }) => {
    const image = await decode(shot)
    return crop({ image, rect: box, scale: image.width / viewportWidth })
  },
})

const daemon = createDaemonClient({ createSocket: webSocketFactory(DAEMON_URL), onRecapture: recapture })
daemon.start()

async function handle(req: Request, sender: chrome.runtime.MessageSender): Promise<Responses[Request['kind']]> {
  const tab = sender.tab
  if (tab?.id === undefined) throw new Error('No sender tab')
  const tabId = tab.id
  switch (req.kind) {
    case 'inspect':
      return inspectTab({ tabId, frameId: sender.frameId ?? 0, marker: req.marker })
    case 'capture': {
      const viewport = await captureVisible(tab.windowId)
      const image = await decode(viewport)
      const scale = image.width / req.viewportWidth
      return { viewport, crop: await crop({ image, rect: req.rect, scale }), dpr: scale }
    }
    case 'get-batch':
      return (await read(batchKey(tabId))) ?? emptyBatch
    case 'add-pin':
      return withTab(tabId, async () => {
        const batch = (await read(batchKey(tabId))) ?? emptyBatch
        const shot: ViewportShot = { image: req.viewport, dpr: req.dpr, rects: req.rects }
        return writeBatch(tabId, {
          pins: [...batch.pins, req.pin],
          viewports: { ...batch.viewports, [req.pin.path]: shot },
        })
      })
    case 'delete-pin':
      return withTab(tabId, async () => {
        const batch = (await read(batchKey(tabId))) ?? emptyBatch
        const pins = batch.pins.filter(p => p.id !== req.id)
        const viewports = Object.fromEntries(
          Object.entries(batch.viewports).filter(([path]) => pins.some(p => p.path === path)),
        )
        return writeBatch(tabId, { pins, viewports })
      })
    case 'export':
      return withTab(tabId, () => exportBatch({ tabId, origin: req.origin }))
    case 'quick-grab': {
      const page = { path: req.pin.path, url: req.pin.url, viewportFile: null, pins: [{ pin: req.pin, cropFile: null }] }
      return { markdown: toMarkdown({ origin: req.origin, createdAt: req.pin.createdAt, pages: [page], level: await savedLevel() }) }
    }
    case 'daemon-status':
      return { connected: daemon.isConnected() }
    case 'send':
      return withTab(tabId, () => sendBatch({ tabId, origin: req.origin }))
    case 'undo':
      return withTab(tabId, async () => {
        const previous = await read(undoKey(tabId))
        if (!previous) return (await read(batchKey(tabId))) ?? emptyBatch
        await chrome.storage.local.remove(undoKey(tabId))
        return writeBatch(tabId, previous)
      })
    default:
      return assertNever(req)
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (reply: Reply<Request['kind']>) => void) => {
  if (sender.id !== chrome.runtime.id || !hasRequestKind(message)) return false
  handle(message, sender).then(
    data => sendResponse({ ok: true, data }),
    (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  )
  return true
})

chrome.action.onClicked.addListener(tab => void toggle(tab))

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-annotate' && tab) void toggle(tab)
})

chrome.tabs.onRemoved.addListener(tabId => void chrome.storage.local.remove([batchKey(tabId), undoKey(tabId)]))

chrome.runtime.onStartup.addListener(async () => {
  const all: Record<string, unknown> = await chrome.storage.local.get(null)
  await chrome.storage.local.remove(Object.keys(all).filter(k => k.startsWith('batch:') || k.startsWith('undo:')))
})

Reflect.set(globalThis, 'annotateDomToggle', toggle)
