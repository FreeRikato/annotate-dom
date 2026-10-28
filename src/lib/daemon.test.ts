// @vitest-environment happy-dom
import { Window } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import manifest from '../../public/manifest.json'
import {
  clearRecaptureTarget, createDaemonClient, createRecaptureHandler, FIRST_RETRY_MS, markRecaptureTarget, parseSavedLevel, TARGET_ATTR, waitForQuiet, MAX_RETRY_MS, PING_MS, SEND_TIMEOUT_MS, sendLabel,
  type RecaptureTabs, type SocketHandlers, type SocketLike,
} from './daemon'
import { inspectElement } from '../inspect'
import { isDocument } from './deep'
import { isDetailLevel, type Inspection } from './types'

describe('isDetailLevel', () => {
  it.each(['compact', 'standard', 'forensic'])('accepts %s', level => expect(isDetailLevel(level)).toBe(true))
  it.each(['loud', '', 3, null, undefined])('rejects %s', value => expect(isDetailLevel(value)).toBe(false))
})

describe('parseSavedLevel', () => {
  it.each(['compact', 'standard', 'forensic'])('reads %s from the saved settings', level => expect(parseSavedLevel({ level })).toBe(level))
  it.each([{ level: 'loud' }, {}, null, undefined, 'forensic', 3])('returns nothing for %j', settings => expect(parseSavedLevel(settings)).toBeUndefined())
})

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
  const latest = (): FakeSocket => {
    const socket = sockets.at(-1)
    if (!socket) throw new Error('no socket yet')
    return socket
  }
  return { client, sockets, latest }
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

describe('recapture', () => {
  const box = { x: 10, y: 20, w: 100, h: 40 }
  const inspection: Inspection = {
    selector: 'button', tag: 'button', html: '<button>Save</button>', htmlTruncated: false, text: 'Save',
    box: { x: 10, y: 20, w: 100, h: 40 }, styles: {}, attributes: {}, ancestors: [],
    viewport: { width: 800, height: 600, dpr: 1 }, react: null,
  }
  const request = { reqId: 'r1', url: 'http://localhost:3000/', selector: 'button', locator: null }

  function fakeTabs(overrides: Partial<RecaptureTabs> = {}) {
    const calls: string[] = []
    const tabs: RecaptureTabs = {
      findTab: async () => null,
      openTab: async () => { calls.push('open'); return 7 },
      closeTab: async () => { calls.push('close') },
      settle: async () => { calls.push('settle') },
      mark: async () => box,
      unmark: async () => { calls.push('unmark') },
      inspect: async () => inspection,
      screenshot: async () => 'data:image/png;base64,AAAA',
      crop: async ({ box: b }) => `cropped:${b.w}`,
      ...overrides,
    }
    return { tabs, calls }
  }

  it('reuses an open tab on the pin URL and leaves it open', async () => {
    const { tabs, calls } = fakeTabs({ findTab: async url => (url === request.url ? 3 : null) })
    const reply = await createRecaptureHandler(tabs)(request)
    expect(reply).toEqual({ ok: true, crop: 'cropped:100', inspection })
    expect(calls).toEqual(['settle', 'unmark'])
  })

  it('opens a tab when none matches and closes it afterwards', async () => {
    const { tabs, calls } = fakeTabs()
    const reply = await createRecaptureHandler(tabs)(request)
    expect(reply.ok).toBe(true)
    expect(calls).toEqual(['open', 'settle', 'unmark', 'close'])
  })

  it('answers element not found, takes no screenshot, and still closes the opened tab', async () => {
    const screenshot = vi.fn(async () => 'x')
    const { tabs, calls } = fakeTabs({ mark: async () => null, screenshot })
    expect(await createRecaptureHandler(tabs)(request)).toEqual({ ok: false, reason: 'element not found' })
    expect(screenshot).not.toHaveBeenCalled()
    expect(calls).toEqual(['open', 'settle', 'close'])
  })

  it('answers element not found when the marked element cannot be inspected', async () => {
    const screenshot = vi.fn(async () => 'x')
    const { tabs, calls } = fakeTabs({ inspect: async () => null, screenshot })
    expect(await createRecaptureHandler(tabs)(request)).toEqual({ ok: false, reason: 'element not found' })
    expect(screenshot).not.toHaveBeenCalled()
    expect(calls).toContain('unmark')
  })

  it('removes the marker from an existing tab even when the unmark step fails', async () => {
    const { tabs } = fakeTabs({ findTab: async () => 3, unmark: async () => { throw new Error('tab gone') } })
    expect((await createRecaptureHandler(tabs)(request)).ok).toBe(true)
  })

  it('reports a failure message and closes the opened tab when capture throws', async () => {
    const { tabs, calls } = fakeTabs({ screenshot: async () => { throw new Error('debugger busy') } })
    expect(await createRecaptureHandler(tabs)(request)).toEqual({ ok: false, reason: 'debugger busy' })
    expect(calls).toEqual(['open', 'settle', 'unmark', 'close'])
  })

  it('refuses to open or capture any url outside http://localhost and http://127.0.0.1', async () => {
    const findTab = vi.fn(async () => null)
    const openTab = vi.fn(async () => 7)
    const { tabs } = fakeTabs({ findTab, openTab })
    const handler = createRecaptureHandler(tabs)
    for (const url of [
      'https://bank.example/account', 'https://localhost:3000/', 'http://localhost.evil.example/', 'http://localhost@evil.example/',
      'http://127.0.0.1.evil.example/', 'file:///etc/passwd', 'chrome://settings', 'not a url',
    ]) {
      expect(await handler({ ...request, url })).toEqual({ ok: false, reason: 'Recapture only opens http://localhost and http://127.0.0.1 pages' })
    }
    expect(findTab).not.toHaveBeenCalled()
    expect(openTab).not.toHaveBeenCalled()
  })

  it('accepts localhost and 127.0.0.1 on any port', async () => {
    for (const url of ['http://localhost:3000/settings?tab=a', 'http://127.0.0.1:5173/', 'http://localhost/']) {
      expect((await createRecaptureHandler(fakeTabs().tabs)({ ...request, url })).ok).toBe(true)
    }
  })

  it('answers a recapture frame with a recapture-result frame', async () => {
    const sockets: FakeSocket[] = []
    const client = createDaemonClient({
      createSocket: handlers => { const socket = new FakeSocket(handlers); sockets.push(socket); return socket },
      onRecapture: createRecaptureHandler(fakeTabs().tabs),
    })
    client.start()
    const socket = sockets[0]
    if (!socket) throw new Error('no socket yet')
    socket.handlers.onOpen()
    socket.reply({ type: 'recapture', ...request })
    await vi.waitFor(() => expect(socket.sent).toContainEqual({ type: 'recapture-result', reqId: 'r1', ok: true, crop: 'cropped:100', inspection }))
  })

  it('needs the debugger permission and no tabs permission', () => {
    expect(manifest.permissions).toContain('debugger')
    expect(manifest.permissions).not.toContain('tabs')
  })
})

describe('markRecaptureTarget', () => {
  const inPage: typeof markRecaptureTarget = new Function(`return ${markRecaptureTarget.toString()}`)()
  const mark = (selector: string, locator: string | null) => inPage({ selector, locator, marker: 'm', attr: TARGET_ATTR })

  it('prefers the locator and falls back to the selector', () => {
    document.body.innerHTML = '<button id="a">Save</button><button id="b">Toggle dark mode</button>'
    expect(mark('#a', "getByRole('button', { name: 'Toggle dark mode' })")).not.toBeNull()
    expect(document.querySelector('#b')?.getAttribute(TARGET_ATTR)).toBe('m')
    document.querySelector('#b')?.removeAttribute(TARGET_ATTR)
    mark('#a', "getByRole('button', { name: 'Gone' })")
    expect(document.querySelector('#a')?.getAttribute(TARGET_ATTR)).toBe('m')
  })

  it('never guesses: an ambiguous locator and a missing selector find nothing', () => {
    document.body.innerHTML = '<button>Save</button><button>Save</button>'
    expect(mark('#nope', "getByRole('button', { name: 'Save' })")).toBeNull()
    expect(document.querySelector(`[${TARGET_ATTR}]`)).toBeNull()
  })
})

describe('markRecaptureTarget through a deep selector', () => {
  const inPage: typeof markRecaptureTarget = new Function(`return ${markRecaptureTarget.toString()}`)()
  const mark = (selector: string, locator: string | null = null) => inPage({ selector, locator, marker: 'm', attr: TARGET_ATTR })

  // happy-dom cannot load iframe pages, so a plain element stands in with the iframe's contentDocument and frameElement wiring
  function frameWith(id: string, bodyMarkup: string, offset: { x: number; y: number }): Document {
    document.body.insertAdjacentHTML('beforeend', `<div id="${id}"></div>`)
    const frame = document.getElementById(id)
    if (!frame) throw new Error('fixture missing')
    const inner = new Window().document
    inner.body.innerHTML = bodyMarkup
    Object.defineProperty(frame, 'contentDocument', { value: inner })
    Object.defineProperty(inner.defaultView, 'frameElement', { value: frame })
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(offset.x, offset.y, 300, 200))
    if (!isDocument(inner)) throw new Error('fixture is not a document')
    return inner
  }

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('marks the inner element of an open shadow root', () => {
    document.body.innerHTML = '<div id="card-host"></div>'
    const root = document.getElementById('card-host')?.attachShadow({ mode: 'open' })
    if (!root) throw new Error('fixture missing')
    root.innerHTML = '<button id="inner">Save</button>'
    const inner = root.querySelector('button')
    if (!inner) throw new Error('fixture missing')
    vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue(new DOMRect(30, 40, 50, 20))

    expect(mark('#card-host >>> #inner')).toEqual({ x: 30, y: 40, w: 50, h: 20 })
    expect(inner.getAttribute(TARGET_ATTR)).toBe('m')
  })

  it('marks the inner element of an iframe and reports its box in top-page coordinates', () => {
    const doc = frameWith('pane', '<button id="b">Go</button>', { x: 100, y: 200 })
    const inner = doc.querySelector('#b')
    if (!inner) throw new Error('fixture missing')
    vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue(new DOMRect(5, 6, 50, 20))

    expect(mark('#pane >>> #b')).toEqual({ x: 105, y: 206, w: 50, h: 20 })
    expect(inner.getAttribute(TARGET_ATTR)).toBe('m')
  })

  it('adds the frame border and padding to the box of an element in an iframe', () => {
    const doc = frameWith('pane', '<p id="b">hi</p>', { x: 100, y: 200 })
    const frame = document.getElementById('pane')
    if (!frame) throw new Error('fixture missing')
    frame.setAttribute('style', 'padding: 6px 4px')
    Object.defineProperty(frame, 'clientLeft', { value: 2 })
    Object.defineProperty(frame, 'clientTop', { value: 3 })
    const inner = doc.querySelector('#b')
    if (!inner) throw new Error('fixture missing')
    vi.spyOn(inner, 'getBoundingClientRect').mockReturnValue(new DOMRect(5, 6, 50, 20))
    expect(mark('#pane >>> #b')).toEqual({ x: 111, y: 215, w: 50, h: 20 })
  })

  it('resolves a plain selector that has the separator inside an attribute value', () => {
    document.body.innerHTML = '<a data-x="a >>> b" id="t">x</a>'
    expect(mark('a[data-x="a >>> b"]')).not.toBeNull()
    expect(document.getElementById('t')?.getAttribute(TARGET_ATTR)).toBe('m')
  })

  it('splits only at separators outside quotes and brackets', () => {
    document.body.innerHTML = '<div id="h" data-x="a >>> b"></div>'
    const root = document.getElementById('h')?.attachShadow({ mode: 'open' })
    if (!root) throw new Error('fixture missing')
    root.innerHTML = '<b>q</b>'
    expect(mark('div[data-x="a >>> b"] >>> b')).not.toBeNull()
    expect(root.querySelector('b')?.getAttribute(TARGET_ATTR)).toBe('m')
  })

  it('ignores a contentDocument that is not a document', () => {
    document.body.innerHTML = '<div id="fake"><p>x</p></div>'
    const fake = document.getElementById('fake')
    if (!fake) throw new Error('fixture missing')
    Object.defineProperty(fake, 'contentDocument', { value: { nodeType: 1, querySelector: () => fake } })
    expect(mark('#fake >>> p')).toBeNull()
  })

  it('finds nothing when a segment is missing, and ignores a locator that cannot see inside', () => {
    frameWith('pane', '<button id="b">Go</button>', { x: 0, y: 0 })
    expect(mark('#pane >>> #gone')).toBeNull()
    expect(mark('#nope >>> #b')).toBeNull()
    expect(mark('#pane >>> p[')).toBeNull()
    expect(mark('#pane >>> #b', "getByRole('button', { name: 'Missing' })")).not.toBeNull()
  })
})

describe('clearRecaptureTarget across documents', () => {
  const inPage: typeof clearRecaptureTarget = new Function(`return ${clearRecaptureTarget.toString()}`)()

  it('removes the marker from an element in a shadow root', () => {
    document.body.innerHTML = '<div id="host"></div>'
    const root = document.getElementById('host')?.attachShadow({ mode: 'open' })
    if (!root) throw new Error('fixture missing')
    root.innerHTML = '<button id="inner">Save</button>'
    root.querySelector('button')?.setAttribute(TARGET_ATTR, 'recapture-1')
    inPage({ marker: 'recapture-1', attr: TARGET_ATTR })
    expect(root.innerHTML).toBe('<button id="inner">Save</button>')
  })
})

describe('clearRecaptureTarget', () => {
  const inPage: typeof clearRecaptureTarget = new Function(`return ${clearRecaptureTarget.toString()}`)()

  it('removes the marker so a later html comparison sees the original markup', () => {
    document.body.innerHTML = '<div class="card"><button>Save</button></div>'
    const button = document.querySelector('button')
    button?.setAttribute(TARGET_ATTR, 'recapture-1')
    inPage({ marker: 'recapture-1', attr: TARGET_ATTR })
    expect(document.body.innerHTML).toBe('<div class="card"><button>Save</button></div>')
  })
})

describe('markRecaptureTarget with the locators inspect writes', () => {
  const inspectInPage: typeof inspectElement = new Function(`return ${inspectElement.toString()}`)()
  const markInPage: typeof markRecaptureTarget = new Function(`return ${markRecaptureTarget.toString()}`)()
  const subjects: Record<string, string> = {
    heading: '<h1 data-annotate-dom-target="p">Settings</h1><p>other</p>',
    'labelled email input': '<label for="e">Email address</label><input id="e" type="email" data-annotate-dom-target="p" /><input type="text" aria-label="Name" />',
    'labelled checkbox': '<input type="checkbox" aria-label="Agree" data-annotate-dom-target="p" /><input type="checkbox" aria-label="Subscribe" />',
    image: '<img alt="Company logo" data-annotate-dom-target="p" /><img alt="Avatar" />',
    link: '<a href="/docs" data-annotate-dom-target="p">Docs</a><a href="/blog">Blog</a>',
    'aria-labelledby button': '<span id="l">Close dialog</span><button aria-labelledby="l" data-annotate-dom-target="p"></button><button>Open</button>',
    'submit input': '<input type="submit" value="Go" data-annotate-dom-target="p" /><input type="reset" value="Clear" />',
    'unique text': '<div data-annotate-dom-target="p">Only here</div><div>Elsewhere</div>',
    'test id': '<div data-testid="card" data-annotate-dom-target="p"><i></i></div><div data-testid="other"><i></i></div>',
  }

  const DOM_CONSTRUCTORS = ['Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLImageElement']

  beforeEach(() => {
    for (const constructorName of DOM_CONSTRUCTORS) vi.stubGlobal(constructorName, class {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  for (const [name, html] of Object.entries(subjects)) {
    it(`finds the ${name} by its locator without the selector, whichever constructors the page has`, () => {
      document.body.innerHTML = html
      const subject = document.querySelector('[data-annotate-dom-target="p"]')
      const locator = inspectInPage('p')?.locator
      expect(locator).toBeTruthy()
      subject?.removeAttribute(TARGET_ATTR)
      expect(markInPage({ selector: '#does-not-exist', locator: locator ?? null, marker: 'found', attr: TARGET_ATTR })).not.toBeNull()
      expect(document.querySelector('[data-annotate-dom-target="found"]')).toBe(subject)
    })
  }
})

describe('waitForQuiet', () => {
  it('resolves after the quiet period without mutations and at the cap while they continue', async () => {
    vi.useFakeTimers()
    const settled = vi.fn()
    void waitForQuiet({ quietMs: 1000, capMs: 10_000 }).then(settled)
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toHaveBeenCalled()

    const capped = vi.fn()
    void waitForQuiet({ quietMs: 1000, capMs: 10_000 }).then(capped)
    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(900)
      document.body.append(document.createElement('i'))
    }
    expect(capped).toHaveBeenCalled()
  })
})
