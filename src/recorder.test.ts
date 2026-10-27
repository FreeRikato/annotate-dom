// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import manifest from '../public/manifest.json'
import { installRecorder, RECORDER_KEY, type RecorderTarget } from './recorder'
import type { RecordedEvents } from './lib/types'

class FakeXhr {
  static received: unknown[][] = []
  status = 0
  private done: (() => void)[] = []
  open(...args: unknown[]): void {
    FakeXhr.received.push(['open', ...args])
  }
  send(...args: unknown[]): void {
    FakeXhr.received.push(['send', ...args])
  }
  addEventListener(_type: 'loadend', fn: () => void): void {
    this.done.push(fn)
  }
  finish(status: number): void {
    this.status = status
    for (const fn of this.done) fn()
  }
}

class FakeRejection extends Event {
  readonly promise = Promise.resolve()
  readonly reason: unknown
  constructor(reason: unknown) {
    super('unhandledrejection')
    this.reason = reason
  }
}

function setup() {
  let clock = 1_000_000
  const handlers = new Map<string, (event: ErrorEvent | PromiseRejectionEvent) => void>()
  const calls: unknown[][] = []
  let backend: () => Promise<Response> = async () => new Response('', { status: 200 })
  const target: RecorderTarget = {
    console: { error: (...args: unknown[]) => void calls.push(args) },
    fetch: () => backend(),
    XMLHttpRequest: FakeXhr,
    addEventListener: (type, fn) => void handlers.set(type, fn),
  }
  installRecorder(target, () => clock)
  const read = (): RecordedEvents => Reflect.get(target, RECORDER_KEY).read()
  const advance = (ms: number) => void (clock += ms)
  const respondWith = (status: number, takes = 0) => {
    backend = async () => {
      advance(takes)
      return new Response('', { status })
    }
  }
  const failWith = (error: Error, takes = 0) => {
    backend = async () => {
      advance(takes)
      throw error
    }
  }
  return { target, handlers, calls, read, advance, respondWith, failWith }
}

describe('page recorder', () => {
  it('records a 500 fetch with method, url, status and duration', async () => {
    const page = setup()
    page.respondWith(500, 120)
    await page.target.fetch('http://localhost:3000/api/items', { method: 'POST' })
    expect(page.read().network).toEqual([
      { at: 1_000_120, method: 'POST', url: 'http://localhost:3000/api/items', status: 500, durationMs: 120 },
    ])
  })

  it('records console.error and still calls the original', () => {
    const page = setup()
    page.target.console.error('boom', new Error('inner'))
    expect(page.calls).toEqual([['boom', expect.any(Error)]])
    expect(page.read().console).toEqual([{ at: 1_000_000, message: 'boom inner' }])
  })

  it('records window errors and unhandled rejections', () => {
    const page = setup()
    page.handlers.get('error')?.(new ErrorEvent('error', { message: 'x is not defined' }))
    page.handlers.get('unhandledrejection')?.(new FakeRejection(new Error('nope')))
    expect(page.read().console.map(e => e.message)).toEqual(['x is not defined', 'nope'])
  })

  it('records an XHR that took 3.2 s', () => {
    const page = setup()
    const xhr = new page.target.XMLHttpRequest()
    xhr.open('GET', 'http://localhost:3000/slow')
    xhr.send()
    page.advance(3200)
    if (!(xhr instanceof FakeXhr)) throw new Error('fixture')
    xhr.finish(200)
    expect(page.read().network).toEqual([
      { at: 1_003_200, method: 'GET', url: 'http://localhost:3000/slow', status: 200, durationMs: 3200 },
    ])
  })

  it('forwards the async flag, credentials and body of an XHR to the original', () => {
    const page = setup()
    FakeXhr.received = []
    const xhr = new page.target.XMLHttpRequest()
    xhr.open('POST', '/api/save', false, 'user', 'pass')
    xhr.send('{"name":"a"}')
    expect(FakeXhr.received).toEqual([
      ['open', 'POST', '/api/save', false, 'user', 'pass'],
      ['send', '{"name":"a"}'],
    ])
  })

  it('redacts secret query parameters in recorded urls and console messages', async () => {
    const page = setup()
    page.respondWith(401)
    await page.target.fetch('http://localhost:3000/api/me?access_token=abc123&page=2')
    page.target.console.error('GET /api/me?api_key=k-1&page=2 failed with password=hunter2')
    expect(page.read().network[0]?.url).toBe('http://localhost:3000/api/me?access_token=[redacted]&page=2')
    expect(page.read().console[0]?.message).toBe('GET /api/me?api_key=[redacted]&page=2 failed with password=[redacted]')
  })

  it('records a network failure with a null status and rethrows', async () => {
    const page = setup()
    page.failWith(new TypeError('Failed to fetch'), 5)
    await expect(page.target.fetch('http://localhost:3000/down')).rejects.toThrow('Failed to fetch')
    expect(page.read().network[0]).toMatchObject({ url: 'http://localhost:3000/down', status: null })
  })

  it('drops fast successes and keeps requests of exactly the slow threshold', async () => {
    const page = setup()
    page.respondWith(200, 40)
    await page.target.fetch('http://localhost:3000/fast')
    page.respondWith(200, 1000)
    await page.target.fetch('http://localhost:3000/slowish')
    page.respondWith(200, 1001)
    await page.target.fetch('http://localhost:3000/slow')
    expect(page.read().network.map(e => e.url)).toEqual(['http://localhost:3000/slow'])
  })

  it('keeps 400 and drops 399', async () => {
    const page = setup()
    page.respondWith(399)
    await page.target.fetch('http://localhost:3000/a')
    page.respondWith(400)
    await page.target.fetch('http://localhost:3000/b')
    expect(page.read().network.map(e => e.url)).toEqual(['http://localhost:3000/b'])
  })

  it('forgets events older than 30 seconds', () => {
    const page = setup()
    page.target.console.error('old')
    page.advance(30_001)
    page.target.console.error('new')
    expect(page.read().console.map(e => e.message)).toEqual(['new'])
  })

  it('keeps an event exactly 30 seconds old', () => {
    const page = setup()
    page.target.console.error('edge')
    page.advance(30_000)
    expect(page.read().console).toHaveLength(1)
  })

  it('cuts messages and urls at 300 characters', () => {
    const page = setup()
    page.target.console.error('m'.repeat(400))
    expect(page.read().console[0]?.message).toHaveLength(300)
  })

  it('keeps the global non-enumerable and installs once', () => {
    const page = setup()
    expect(Object.keys(page.target)).not.toContain(RECORDER_KEY)
    const first = Reflect.get(page.target, RECORDER_KEY)
    installRecorder(page.target)
    expect(Reflect.get(page.target, RECORDER_KEY)).toBe(first)
  })
})

describe('manifest', () => {
  const origins = ['http://localhost/*', 'http://127.0.0.1/*']

  it('injects the recorder into the page world at document start on localhost only', () => {
    expect(manifest.content_scripts).toEqual([
      { matches: origins, js: ['recorder.js'], run_at: 'document_start', world: 'MAIN' },
    ])
  })

  it('asks for host access to the same origins', () => {
    expect(manifest.host_permissions).toEqual(origins)
  })
})
