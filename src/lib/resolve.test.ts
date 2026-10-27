import { describe, expect, it } from 'vitest'
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
})
