import { isDetailLevel, type Box, type DetailLevel, type Inspection, type Pin } from './types'

export const DAEMON_URL = 'ws://localhost:4747/ws'
export const PING_MS = 20_000
export const FIRST_RETRY_MS = 250
export const MAX_RETRY_MS = 5_000
export const SEND_TIMEOUT_MS = 30_000
export const TARGET_ATTR = 'data-annotate-dom-target'
export const SETTINGS_KEY = 'settings'

export function parseSavedLevel(settings: unknown): DetailLevel | undefined {
  const level = typeof settings === 'object' && settings !== null && 'level' in settings ? settings.level : undefined
  return isDetailLevel(level) ? level : undefined
}

export type BatchFrame = {
  readonly type: 'batch'
  readonly reqId: string
  readonly origin: string
  readonly createdAt: number
  readonly pages: readonly { readonly path: string; readonly url: string; readonly viewport: string | null }[]
  readonly pins: readonly (Pin & { readonly n: number })[]
  readonly level?: DetailLevel
}

export type SavedBatch = { readonly project: string; readonly folder: string; readonly prompt: string }

export type RecaptureRequest = {
  readonly reqId: string
  readonly url: string
  readonly selector: string
  readonly locator: string | null
}

export type RecaptureReply =
  | { readonly ok: true; readonly crop: string; readonly inspection: Inspection }
  | { readonly ok: false; readonly reason: string }

export type RecaptureTabs = {
  readonly findTab: (url: string) => Promise<number | null>
  readonly openTab: (url: string) => Promise<number>
  readonly closeTab: (tabId: number) => Promise<void>
  readonly settle: (tabId: number) => Promise<void>
  readonly mark: (args: { readonly tabId: number; readonly selector: string; readonly locator: string | null; readonly marker: string }) => Promise<Box | null>
  readonly unmark: (args: { readonly tabId: number; readonly marker: string }) => Promise<void>
  readonly inspect: (args: { readonly tabId: number; readonly marker: string }) => Promise<Inspection | null>
  readonly screenshot: (tabId: number) => Promise<string>
  readonly crop: (args: { readonly shot: string; readonly box: Box; readonly viewportWidth: number }) => Promise<string>
}

export const ELEMENT_NOT_FOUND = 'element not found'
export const URL_NOT_ALLOWED = 'Recapture only opens http://localhost and http://127.0.0.1 pages'

function isLocalPage(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    return protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1')
  } catch {
    return false
  }
}

export function createRecaptureHandler(tabs: RecaptureTabs) {
  return async ({ reqId, url, selector, locator }: RecaptureRequest): Promise<RecaptureReply> => {
    if (!isLocalPage(url)) return { ok: false, reason: URL_NOT_ALLOWED }
    const existing = await tabs.findTab(url)
    const tabId = existing ?? await tabs.openTab(url)
    try {
      await tabs.settle(tabId)
      const marker = `recapture-${reqId}`
      const box = await tabs.mark({ tabId, selector, locator, marker })
      if (!box) return { ok: false, reason: ELEMENT_NOT_FOUND }
      try {
        const inspection = await tabs.inspect({ tabId, marker })
        if (!inspection) return { ok: false, reason: ELEMENT_NOT_FOUND }
        const shot = await tabs.screenshot(tabId)
        const crop = await tabs.crop({ shot, box, viewportWidth: inspection.viewport.width })
        return { ok: true, crop, inspection }
      } finally {
        await tabs.unmark({ tabId, marker }).catch(() => undefined)
      }
    } catch (err: unknown) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    } finally {
      if (existing === null) await tabs.closeTab(tabId).catch(() => undefined)
    }
  }
}

export function markRecaptureTarget({ selector, locator, marker, attr }: {
  readonly selector: string
  readonly locator: string | null
  readonly marker: string
  readonly attr: string
}): Box | null {
  const text = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()
  const contains = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle.toLowerCase())
  const tagRoles: Record<string, string> = {
    button: 'button', select: 'combobox', textarea: 'textbox', img: 'img', nav: 'navigation', main: 'main',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  }
  const inputRoles: Record<string, string> = {
    button: 'button', submit: 'button', reset: 'button', checkbox: 'checkbox', radio: 'radio',
    range: 'slider', search: 'searchbox', text: 'textbox', email: 'textbox', tel: 'textbox', url: 'textbox', number: 'spinbutton',
  }
  const hasTag = (el: Element, tag: string) => el.localName === tag && el.namespaceURI === 'http://www.w3.org/1999/xhtml'
  const isInput = (el: Element): el is HTMLInputElement => hasTag(el, 'input')
  const isSelect = (el: Element): el is HTMLSelectElement => hasTag(el, 'select')
  const isTextArea = (el: Element): el is HTMLTextAreaElement => hasTag(el, 'textarea')
  const isImage = (el: Element): el is HTMLImageElement => hasTag(el, 'img')
  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0]
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null
    if (tag === 'input') return inputRoles[(el.getAttribute('type') ?? 'text').toLowerCase()] ?? null
    return tagRoles[tag] ?? null
  }
  const labelOf = (el: Element): string => {
    const aria = text(el.getAttribute('aria-label'))
    if (aria) return aria
    const ids = el.getAttribute('aria-labelledby')?.split(/\s+/) ?? []
    const referenced = ids.map(id => text(el.ownerDocument.getElementById(id)?.textContent ?? '')).join(' ').trim()
    if (referenced) return referenced
    if (!(isInput(el) || isSelect(el) || isTextArea(el))) return ''
    return text(Array.from(el.labels ?? []).map(l => l.textContent).join(' '))
  }
  const nameOf = (el: Element): string => {
    const label = labelOf(el)
    if (label) return label
    if (isInput(el) && ['button', 'submit', 'reset'].includes(el.type)) return text(el.value)
    if (isImage(el)) return text(el.alt)
    return text(el.textContent)
  }
  const quoted = "'((?:[^'\\\\]|\\\\.)*)'"
  const unquote = (value: string | undefined) => (value ?? '').replace(/\\(['\\])/g, '$1')
  const all = Array.from(document.querySelectorAll('*'))
  const only = (matching: (el: Element) => boolean) => {
    const hits = all.filter(matching)
    return hits.length === 1 ? hits[0] : null
  }
  function byLocator(source: string): Element | null {
    const role = new RegExp(`^getByRole\\(${quoted}, \\{ name: ${quoted} \\}\\)$`).exec(source)
    if (role) return only(el => roleOf(el) === unquote(role[1]) && contains(nameOf(el), unquote(role[2])))
    const label = new RegExp(`^getByLabel\\(${quoted}\\)$`).exec(source)
    if (label) return only(el => contains(labelOf(el), unquote(label[1])))
    const exact = new RegExp(`^getByText\\(${quoted}, \\{ exact: true \\}\\)$`).exec(source)
    if (exact) return only(el => text(el.textContent) === unquote(exact[1]) && !Array.from(el.children).some(c => text(c.textContent) === unquote(exact[1])))
    const testId = new RegExp(`^getByTestId\\(${quoted}\\)$`).exec(source)
    return testId ? only(el => el.getAttribute('data-testid') === unquote(testId[1])) : null
  }
  function splitDeep(source: string): string[] {
    const parts: string[] = []
    let quote = ''
    let from = 0
    for (let i = 0; i < source.length; i++) {
      const ch = source.charAt(i)
      if (ch === '\\') i++
      else if (quote) quote = ch === quote ? '' : quote
      else if (ch === '"' || ch === "'") quote = ch
      else if (source.startsWith(' >>> ', i)) {
        parts.push(source.slice(from, i))
        i += 4
        from = i + 1
      }
    }
    parts.push(source.slice(from))
    return parts
  }
  const isDocumentNode = (value: unknown): value is Document =>
    typeof value === 'object' && value !== null && Reflect.get(value, 'nodeType') === 9
  function frameDocumentOf(host: Element): Document | null {
    const inner: unknown = Reflect.get(host, 'contentDocument')
    return isDocumentNode(inner) ? inner : null
  }
  function bySelector(source: string): Element | null {
    const segments = splitDeep(source)
    let root: ParentNode | null = document
    try {
      for (const segment of segments.slice(0, -1)) {
        const host: Element | null = root.querySelector(segment)
        root = host && (host.shadowRoot ?? frameDocumentOf(host))
        if (!root) return null
      }
      return root.querySelector(segments[segments.length - 1] ?? '')
    } catch {
      return null
    }
  }
  const el = (locator ? byLocator(locator) : null) ?? bySelector(selector)
  if (!el) return null
  el.setAttribute(attr, marker)
  const rect = el.getBoundingClientRect()
  let x = rect.x
  let y = rect.y
  for (let frame = el.ownerDocument.defaultView?.frameElement; frame; frame = frame.ownerDocument.defaultView?.frameElement) {
    const frameRect = frame.getBoundingClientRect()
    const frameStyle = frame.ownerDocument.defaultView?.getComputedStyle(frame)
    x += frameRect.left + frame.clientLeft + (parseFloat(frameStyle?.paddingLeft ?? '') || 0)
    y += frameRect.top + frame.clientTop + (parseFloat(frameStyle?.paddingTop ?? '') || 0)
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(rect.width), h: Math.round(rect.height) }
}

export function clearRecaptureTarget({ marker, attr }: { readonly marker: string; readonly attr: string }): void {
  function isParentNode(value: unknown): value is ParentNode {
    return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'querySelectorAll') === 'function'
  }
  function clearIn(root: ParentNode): boolean {
    const direct = root.querySelector(`[${attr}="${marker}"]`)
    if (direct) {
      direct.removeAttribute(attr)
      return true
    }
    return Array.from(root.querySelectorAll('*')).some(host => {
      const frameContent: unknown = Reflect.get(host, 'contentDocument')
      const inner = host.shadowRoot ?? (isParentNode(frameContent) ? frameContent : null)
      return !!inner && clearIn(inner)
    })
  }
  clearIn(document)
}

export function waitForQuiet({ quietMs, capMs }: { readonly quietMs: number; readonly capMs: number }): Promise<void> {
  return new Promise(resolve => {
    let quiet: ReturnType<typeof setTimeout>
    const done = () => {
      observer.disconnect()
      clearTimeout(quiet)
      clearTimeout(cap)
      resolve()
    }
    const observer = new MutationObserver(() => {
      clearTimeout(quiet)
      quiet = setTimeout(done, quietMs)
    })
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    quiet = setTimeout(done, quietMs)
    const cap = setTimeout(done, capMs)
  })
}

type ServerFrame =
  | ({ readonly type: 'recapture' } & RecaptureRequest)
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
  if (
    frame.type === 'recapture' && 'url' in frame && typeof frame.url === 'string' && 'selector' in frame &&
    typeof frame.selector === 'string' && 'locator' in frame && (typeof frame.locator === 'string' || frame.locator === null)
  ) {
    return { type: 'recapture', reqId: frame.reqId, url: frame.url, selector: frame.selector, locator: frame.locator }
  }
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

export function createDaemonClient({ createSocket, onRecapture }: {
  readonly createSocket: SocketFactory
  readonly onRecapture?: (request: RecaptureRequest) => Promise<RecaptureReply>
}) {
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
        else if (frame?.type === 'recapture' && onRecapture) {
          const target = socket
          void onRecapture(frame).then(reply => target?.send(JSON.stringify({ type: 'recapture-result', reqId: frame.reqId, ...reply })))
        } else if (frame?.type === 'error') settle(frame.reqId, entry => entry.reject(new Error(frame.message)))
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
