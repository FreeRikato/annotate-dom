import { afterEach, describe, expect, it, vi } from 'vitest'
import { createResolver, type Fetcher } from './resolve'

const ORIGIN = 'http://localhost:3000'
const CHUNK = `${ORIGIN}/_next/static/chunks/abc._.js`

const chunk = ['line1', 'line2', 'line3', 'line4', 'line5', 'createElement()', '//# sourceMappingURL=abc._.js.map'].join('\n')

const sectionedMap = JSON.stringify({
  version: 3,
  sources: [],
  sections: [
    {
      offset: { line: 4, column: 0 },
      map: { version: 3, sources: ['file:///Users/me/app/components/theme-toggle.tsx'], names: [], mappings: ';AACA' },
    },
  ],
})

function routes(table: Record<string, () => Response>): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = []
  const fetcher: Fetcher = async url => {
    calls.push(url)
    const route = table[url]
    return route ? route() : new Response('not found', { status: 404 })
  }
  return { fetcher, calls }
}

describe('createResolver', () => {
  it('traces a client frame through a sectioned source map', async () => {
    const { fetcher, calls } = routes({
      [CHUNK]: () => new Response(chunk),
      [`${CHUNK}.map`]: () => new Response(sectionedMap),
    })
    const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
    const frame = { fn: 'ThemeToggle', file: CHUNK, line: 6, column: 1 }
    expect(await resolver.resolve(frame)).toEqual({ file: '/Users/me/app/components/theme-toggle.tsx', line: 2, column: 1 })
    await resolver.resolve(frame)
    expect(calls).toHaveLength(2)
  })

  it('resolves sources of an inline data URL map against the module URL', async () => {
    const viteOrigin = 'http://localhost:5199'
    const moduleUrl = `${viteOrigin}/src/App.tsx`
    const inlineMap = btoa(JSON.stringify({ version: 3, sources: ['App.tsx'], names: [], mappings: ';AACA' }))
    const dataUrl = `data:application/json;base64,${inlineMap}`
    const { fetcher } = routes({
      [moduleUrl]: () => new Response(`line1\nline2\n//# sourceMappingURL=${dataUrl}`),
      [dataUrl]: () => new Response(atob(inlineMap)),
    })
    const resolver = createResolver({ pageOrigin: viteOrigin, fetcher })
    expect(await resolver.resolve({ fn: 'App', file: moduleUrl, line: 2, column: 1 })).toEqual({
      file: 'src/App.tsx',
      line: 2,
      column: 1,
    })
  })

  it('returns null when the chunk has no source map', async () => {
    const { fetcher } = routes({ [CHUNK]: () => new Response('no map here') })
    const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
    expect(await resolver.resolve({ fn: 'X', file: CHUNK, line: 1, column: 1 })).toBeNull()
  })

  it('resolves server frames through the Next dev endpoint and makes them absolute', async () => {
    const bodies: unknown[] = []
    const fetcher: Fetcher = async (url, init) => {
      expect(url).toBe(`${ORIGIN}/__nextjs_original-stack-frames`)
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json([{ status: 'fulfilled', value: { originalStackFrame: { file: 'app/login/page.tsx', line1: 19, column1: 7 } } }])
    }
    const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
    const loc = await resolver.resolve({
      fn: 'LoginPage',
      file: 'about://React/Server/file:///Users/me/app/.next/dev/server/chunks/ssr/x.js?16',
      line: 92,
      column: 500,
    })
    expect(loc).toEqual({ file: '/Users/me/app/app/login/page.tsx', line: 19, column: 7 })
    expect(bodies[0]).toMatchObject({
      isServer: true,
      frames: [{ file: 'file:///Users/me/app/.next/dev/server/chunks/ssr/x.js', line1: 92, column1: 500 }],
    })
  })

  it('returns null when the Next endpoint rejects the frame', async () => {
    const fetcher: Fetcher = async () => Response.json([{ status: 'rejected', reason: 'nope' }])
    const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
    const loc = await resolver.resolve({ fn: 'P', file: 'about://React/Server/file:///a/.next/x.js', line: 1, column: 1 })
    expect(loc).toBeNull()
  })

  describe('fetch limits', () => {
    afterEach(() => vi.useRealTimers())

    const chunkUrl = (n: number) => `${ORIGIN}/_next/static/chunks/c${n}._.js`
    const frameOn = (n: number) => ({ fn: 'F', file: chunkUrl(n), line: 6, column: 1 })

    it('runs at most 3 fetches at once and still resolves every frame', async () => {
      let inFlight = 0
      let peak = 0
      const fetcher: Fetcher = async url => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise(r => setTimeout(r, 5))
        inFlight--
        if (url.endsWith('.map')) return new Response(sectionedMap)
        return new Response(chunk.replace('abc._.js.map', `${url.split('/').at(-1)}.map`))
      }
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
      const frames = Array.from({ length: 10 }, (_, i) => frameOn(i))
      const results = await resolver.resolveAll(frames)
      expect(peak).toBe(3)
      expect(results).toHaveLength(10)
      for (const loc of results) expect(loc).toEqual({ file: '/Users/me/app/components/theme-toggle.tsx', line: 2, column: 1 })
    })

    it('resolves a frame to null after 8000 ms when its chunk never settles, leaving other frames resolved', async () => {
      vi.useFakeTimers()
      const fetcher: Fetcher = url => {
        if (url === chunkUrl(0)) return new Promise<Response>(() => {})
        if (url.endsWith('.map')) return Promise.resolve(new Response(sectionedMap))
        return Promise.resolve(new Response(chunk.replace('abc._.js.map', `${url.split('/').at(-1)}.map`)))
      }
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
      const pending = resolver.resolveAll([frameOn(0), frameOn(1)])
      await vi.advanceTimersByTimeAsync(7999)
      let settled = false
      void pending.then(() => (settled = true))
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const [hung, healthy] = await pending
      expect(hung).toBeNull()
      expect(healthy).toEqual({ file: '/Users/me/app/components/theme-toggle.tsx', line: 2, column: 1 })
    })

    it('passes an abort signal that fires at the timeout', async () => {
      vi.useFakeTimers()
      let signal: AbortSignal | undefined
      const fetcher: Fetcher = (_url, init) => {
        signal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      }
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
      const pending = resolver.resolve(frameOn(0))
      await vi.advanceTimersByTimeAsync(7999)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(signal?.aborted).toBe(true)
      expect(await pending).toBeNull()
    })

    it('fetches again after a thrown fetch, a 404 chunk and a timed-out chunk', async () => {
      vi.useFakeTimers()
      const behaviours = {
        thrown: () => Promise.reject(new Error('network down')),
        missing: () => Promise.resolve(new Response('nope', { status: 404 })),
        hung: () => new Promise<Response>(() => {}),
      }
      for (const [name, behave] of Object.entries(behaviours)) {
        const calls: string[] = []
        const fetcher: Fetcher = url => {
          calls.push(url)
          return behave()
        }
        const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
        const first = resolver.resolve(frameOn(0))
        await vi.advanceTimersByTimeAsync(8000)
        expect(await first, name).toBeNull()
        const second = resolver.resolve(frameOn(0))
        await vi.advanceTimersByTimeAsync(8000)
        expect(await second, name).toBeNull()
        expect(calls, name).toEqual([chunkUrl(0), chunkUrl(0)])
      }
    })

    it('treats a 404 source map as a failure and fetches it again', async () => {
      const { fetcher, calls } = routes({ [chunkUrl(0)]: () => new Response(chunk) })
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
      expect(await resolver.resolve(frameOn(0))).toBeNull()
      expect(await resolver.resolve(frameOn(0))).toBeNull()
      expect(calls.filter(u => u.endsWith('.map'))).toHaveLength(2)
    })

    it('keeps a successful chunk cached across resolves', async () => {
      const { fetcher, calls } = routes({
        [chunkUrl(0)]: () => new Response(chunk),
        [`${ORIGIN}/_next/static/chunks/abc._.js.map`]: () => new Response(sectionedMap),
      })
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
      await resolver.resolve(frameOn(0))
      await resolver.resolve(frameOn(0))
      expect(calls).toHaveLength(2)
    })

    it('gives the dev-server request the same timeout', async () => {
      vi.useFakeTimers()
      const fetcher: Fetcher = () => new Promise<Response>(() => {})
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
      const pending = resolver.resolve({ fn: 'P', file: 'about://React/Server/file:///a/.next/x.js', line: 1, column: 1 })
      await vi.advanceTimersByTimeAsync(8000)
      expect(await pending).toBeNull()
    })

    it('ignores a non-2xx dev-server response even when its body looks valid', async () => {
      const body = [{ status: 'fulfilled', value: { originalStackFrame: { file: 'app/page.tsx', line1: 1, column1: 1 } } }]
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher: async () => Response.json(body, { status: 500 }) })
      const loc = await resolver.resolve({ fn: 'P', file: 'about://React/Server/file:///a/.next/x.js', line: 1, column: 1 })
      expect(loc).toBeNull()
    })

    it('resolves null entries and keeps input order', async () => {
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher: async () => new Response('', { status: 404 }) })
      expect(await resolver.resolveAll([null, null])).toEqual([null, null])
    })
  })
})
