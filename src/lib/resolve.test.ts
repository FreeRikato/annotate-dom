import { afterEach, describe, expect, it, vi } from 'vitest'
import { createResolver, FETCH_TIMEOUT_MS, MAX_CONCURRENT_FETCHES, RESOLVE_DEADLINE_MS, type Fetcher } from './resolve'

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

  describe('server frames', () => {
    const ENDPOINT = `${ORIGIN}/__nextjs_original-stack-frames`
    const serverFrame = (n: number, prefix = 'about://React/Server/') => ({
      fn: `S${n}`,
      file: `${prefix}file:///app/.next/server/chunks/s${n}.js?${n}`,
      line: n,
      column: n + 1,
    })
    const fulfilled = (file: string, line1: number, extra: Record<string, unknown> = {}) => ({
      status: 'fulfilled',
      value: { originalStackFrame: { file, line1, column1: 1, ...extra } },
    })

    afterEach(() => vi.useRealTimers())

    it('sends all server frames of one resolveAll in a single POST and maps each result to its frame', async () => {
      const posts: { frames: { file: string; line1: number }[] }[] = []
      const fetcher: Fetcher = async (url, init) => {
        if (url === ENDPOINT) {
          posts.push(JSON.parse(String(init?.body)))
          return Response.json([fulfilled('/a.tsx', 11), fulfilled('/b.tsx', 22), fulfilled('/c.tsx', 33)])
        }
        if (url.endsWith('.map')) return new Response(sectionedMap)
        return new Response(chunk)
      }
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
      const client = { fn: 'C', file: CHUNK, line: 6, column: 1 }
      const results = await resolver.resolveAll([
        serverFrame(1),
        client,
        serverFrame(2, 'rsc://React/Server/'),
        client,
        serverFrame(3),
      ])
      expect(posts).toHaveLength(1)
      expect(posts[0].frames.map(f => f.file)).toEqual([
        'file:///app/.next/server/chunks/s1.js',
        'file:///app/.next/server/chunks/s2.js',
        'file:///app/.next/server/chunks/s3.js',
      ])
      expect(posts[0].frames.map(f => f.line1)).toEqual([1, 2, 3])
      expect(results.map(r => r?.line)).toEqual([11, 2, 22, 2, 33])
    })

    it('posts under the basePath when given and at the origin root otherwise', async () => {
      const urls: string[] = []
      const fetcher: Fetcher = async url => {
        urls.push(url)
        return Response.json([fulfilled('/a.tsx', 1)])
      }
      await createResolver({ pageOrigin: ORIGIN, fetcher, basePath: '/docs' }).resolve(serverFrame(1))
      await createResolver({ pageOrigin: ORIGIN, fetcher }).resolve(serverFrame(1))
      expect(urls).toEqual([`${ORIGIN}/docs/__nextjs_original-stack-frames`, ENDPOINT])
    })

    describe('where the stack-frames endpoint lives', () => {
      const answers = (liveAt: string) => {
        const urls: string[] = []
        const fetcher: Fetcher = async url => {
          urls.push(url)
          return url === `${ORIGIN}${liveAt}/__nextjs_original-stack-frames` ? Response.json([fulfilled('/a.tsx', 1)]) : new Response('no', { status: 404 })
        }
        return { urls, fetcher }
      }

      it('retries once at the origin root when the script-derived base answers 404, then keeps the base that answered', async () => {
        const { urls, fetcher } = answers('')
        const resolver = createResolver({ pageOrigin: ORIGIN, fetcher, basePath: '/static' })
        expect((await resolver.resolve(serverFrame(1)))?.file).toBe('/a.tsx')
        expect((await resolver.resolve(serverFrame(1)))?.file).toBe('/a.tsx')
        expect(urls).toEqual([`${ORIGIN}/static/__nextjs_original-stack-frames`, ENDPOINT, ENDPOINT])
      })

      it('goes straight through a real basePath', async () => {
        const { urls, fetcher } = answers('/docs')
        const resolver = createResolver({ pageOrigin: ORIGIN, fetcher, basePath: '/docs' })
        expect((await resolver.resolve(serverFrame(1)))?.file).toBe('/a.tsx')
        expect(urls).toEqual([`${ORIGIN}/docs/__nextjs_original-stack-frames`])
      })

      it('does not retry a failure that is not a 404', async () => {
        const urls: string[] = []
        const fetcher: Fetcher = async url => {
          urls.push(url)
          return new Response('boom', { status: 500 })
        }
        const resolver = createResolver({ pageOrigin: ORIGIN, fetcher, basePath: '/static' })
        expect(await resolver.resolve(serverFrame(1))).toBeNull()
        expect(urls).toHaveLength(1)
      })

      it.each(['//evil.example', '/\\evil.example', '///evil.example/x', '\\\\evil.example'])('keeps a hostile base %s on the page origin', async basePath => {
        const urls: string[] = []
        const fetcher: Fetcher = async url => {
          urls.push(url)
          return new Response('no', { status: 404 })
        }
        await createResolver({ pageOrigin: ORIGIN, fetcher, basePath }).resolve(serverFrame(1))
        expect(urls.length).toBeGreaterThan(0)
        for (const url of urls) expect(new URL(url).origin).toBe(ORIGIN)
      })
    })

    it('keeps the resolved file of a frame the dev server marks ignored, made absolute like any other', async () => {
      const fetcher: Fetcher = async () =>
        Response.json([
          fulfilled('/a.tsx', 11),
          fulfilled('/app/node_modules/next/x.js', 5, { ignored: true }),
          fulfilled('node_modules/next/y.js', 7, { ignored: true }),
        ])
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
      const results = await resolver.resolveAll([serverFrame(1), serverFrame(2), serverFrame(3)])
      expect(results.map(r => r?.file)).toEqual(['/a.tsx', '/app/node_modules/next/x.js', '/app/node_modules/next/y.js'])
    })

    it('leaves every server frame unresolved on a non-2xx, a thrown fetch or a hang, and still settles', async () => {
      vi.useFakeTimers()
      const behaviours = {
        non2xx: () => Promise.resolve(Response.json([fulfilled('/a.tsx', 1), fulfilled('/b.tsx', 2)], { status: 500 })),
        thrown: () => Promise.reject(new Error('network down')),
        hung: () => new Promise<Response>(() => {}),
      }
      for (const [name, behave] of Object.entries(behaviours)) {
        const resolver = createResolver({ pageOrigin: ORIGIN, fetcher: () => behave() })
        const pending = resolver.resolveAll([serverFrame(1), serverFrame(2)])
        await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS)
        expect(await pending, name).toEqual([null, null])
      }
    })
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
      expect(peak).toBe(MAX_CONCURRENT_FETCHES)
      expect(results).toHaveLength(10)
      for (const loc of results) expect(loc).toEqual({ file: '/Users/me/app/components/theme-toggle.tsx', line: 2, column: 1 })
    })

    it('resolves a frame to null after FETCH_TIMEOUT_MS when its chunk never settles, leaving other frames resolved', async () => {
      vi.useFakeTimers()
      const fetcher: Fetcher = url => {
        if (url === chunkUrl(0)) return new Promise<Response>(() => {})
        if (url.endsWith('.map')) return Promise.resolve(new Response(sectionedMap))
        return Promise.resolve(new Response(chunk.replace('abc._.js.map', `${url.split('/').at(-1)}.map`)))
      }
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
      const pending = resolver.resolveAll([frameOn(0), frameOn(1)])
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 1)
      let settled = false
      void pending.then(() => (settled = true))
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const [hung, healthy] = await pending
      expect(hung).toBeNull()
      expect(healthy).toEqual({ file: '/Users/me/app/components/theme-toggle.tsx', line: 2, column: 1 })
    })

    it('finishes a chunk and its map before starting the next chunk, so a slow dev server resolves some frames by the deadline', async () => {
      vi.useFakeTimers()
      const fetchMs = 1900
      const fetcher: Fetcher = async url => {
        await new Promise(r => setTimeout(r, fetchMs))
        if (url.endsWith('.map')) return new Response(sectionedMap)
        return new Response(chunk.replace('abc._.js.map', `${url.split('/').at(-1)}.map`))
      }
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
      const pending = resolver.resolveAll(Array.from({ length: 10 }, (_, i) => frameOn(i)))
      await vi.advanceTimersByTimeAsync(RESOLVE_DEADLINE_MS)
      const resolved = (await pending).filter(loc => loc !== null)
      expect(resolved).toHaveLength(2 * MAX_CONCURRENT_FETCHES)
    })

    it('settles a whole resolveAll at the overall deadline and starts no queued fetch after it', async () => {
      vi.useFakeTimers()
      const calls: string[] = []
      const fetcher: Fetcher = url => {
        calls.push(url)
        return new Promise<Response>(() => {})
      }
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
      const pending = resolver.resolveAll(Array.from({ length: 10 }, (_, i) => frameOn(i)))
      let settled = false
      void pending.then(() => (settled = true))
      await vi.advanceTimersByTimeAsync(RESOLVE_DEADLINE_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await pending).toEqual(Array(10).fill(null))
      await vi.advanceTimersByTimeAsync(RESOLVE_DEADLINE_MS * 4)
      expect(calls).toHaveLength(MAX_CONCURRENT_FETCHES)
    })

    it('lets a later resolveAll finish a chunk load that an earlier one gave up on at its deadline', async () => {
      vi.useFakeTimers()
      const slotHolderMs = 2000
      const slowChunkMs = FETCH_TIMEOUT_MS - 1000
      const fetcher: Fetcher = async url => {
        if (url.endsWith('.map')) return new Response(sectionedMap)
        const slow = url === chunkUrl(0)
        await new Promise(r => setTimeout(r, slow ? slowChunkMs : slotHolderMs))
        return new Response(slow ? chunk : 'no source map here')
      }
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
      const first = resolver.resolveAll([frameOn(1), frameOn(2), frameOn(3), frameOn(0)])
      await vi.advanceTimersByTimeAsync(RESOLVE_DEADLINE_MS)
      expect(await first).toEqual([null, null, null, null])

      const second = resolver.resolveAll([frameOn(0)])
      await vi.advanceTimersByTimeAsync(slotHolderMs + slowChunkMs - RESOLVE_DEADLINE_MS)
      expect(await second).toEqual([{ file: '/Users/me/app/components/theme-toggle.tsx', line: 2, column: 1 }])
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
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 1)
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
        await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS)
        expect(await first, name).toBeNull()
        const second = resolver.resolve(frameOn(0))
        await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS)
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
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS)
      expect(await pending).toBeNull()
    })

    it('ignores a non-2xx dev-server response even when its body looks valid', async () => {
      const body = [{ status: 'fulfilled', value: { originalStackFrame: { file: 'app/page.tsx', line1: 1, column1: 1 } } }]
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher: async () => Response.json(body, { status: 500 }) })
      const loc = await resolver.resolve({ fn: 'P', file: 'about://React/Server/file:///a/.next/x.js', line: 1, column: 1 })
      expect(loc).toBeNull()
    })

    it('resolves a frame to null on a non-2xx from the chunk, the source map and the dev server alike', async () => {
      const serverFrame = { fn: 'P', file: 'about://React/Server/file:///a/.next/x.js', line: 1, column: 1 }
      const ok = (url: string) => (url.endsWith('.map') ? new Response(sectionedMap) : new Response(chunk))
      const cases = {
        chunk: (url: string) => (url === chunkUrl(0) ? new Response('x', { status: 503 }) : ok(url)),
        map: (url: string) => (url.endsWith('.map') ? new Response('x', { status: 503 }) : ok(url)),
        server: () => Response.json([{ status: 'fulfilled', value: { originalStackFrame: { file: 'a.tsx', line1: 1, column1: 1 } } }], { status: 503 }),
      }
      for (const [name, respond] of Object.entries(cases)) {
        const fetcher: Fetcher = async url => respond(url)
        const frame = name === 'server' ? serverFrame : frameOn(0)
        expect(await createResolver({ pageOrigin: ORIGIN, fetcher }).resolve(frame), name).toBeNull()
      }
    })

    it('settles a mixed resolveAll at the deadline when the dev server never answers, keeping the client frames', async () => {
      vi.useFakeTimers()
      const fetcher: Fetcher = url => {
        if (url.endsWith('/__nextjs_original-stack-frames')) return new Promise<Response>(() => {})
        if (url.endsWith('.map')) return Promise.resolve(new Response(sectionedMap))
        return Promise.resolve(new Response(chunk.replace('abc._.js.map', `${url.split('/').at(-1)}.map`)))
      }
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher })
      const server = { fn: 'S', file: 'about://React/Server/file:///a/.next/x.js', line: 1, column: 1 }
      const pending = resolver.resolveAll([frameOn(0), server, frameOn(1), server])
      await vi.advanceTimersByTimeAsync(RESOLVE_DEADLINE_MS)
      const client = { file: '/Users/me/app/components/theme-toggle.tsx', line: 2, column: 1 }
      expect(await pending).toEqual([client, null, client, null])
    })

    it('resolves null entries and keeps input order', async () => {
      const resolver = createResolver({ pageOrigin: ORIGIN, fetcher: async () => new Response('', { status: 404 }) })
      expect(await resolver.resolveAll([null, null])).toEqual([null, null])
    })
  })
})
