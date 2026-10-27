import { FlattenMap, originalPositionFor, type TraceMap } from '@jridgewell/trace-mapping'
import { isServerFrame, normalizeSource, projectRootFromServerFile, serverFileUrl, type Frame } from './stack'
import type { SourceLoc } from './types'

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

type NextFrame = { readonly file: string; readonly line1: number; readonly column1: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nextFrameOf(entry: unknown): NextFrame | null {
  if (!isRecord(entry) || entry.status !== 'fulfilled' || !isRecord(entry.value)) return null
  const frame = entry.value.originalStackFrame
  if (!isRecord(frame)) return null
  const { file, line1, column1 } = frame
  if (typeof file !== 'string' || typeof line1 !== 'number' || typeof column1 !== 'number') return null
  return { file, line1, column1 }
}

function lastSourceMappingUrl(js: string): string | null {
  const matches = [...js.matchAll(/\/\/[#@] sourceMappingURL=(\S+)/g)]
  return matches.at(-1)?.[1] ?? null
}

export const MAX_CONCURRENT_FETCHES = 3
export const FETCH_TIMEOUT_MS = 8000

function createLimiter(maxConcurrent: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async function limited<T>(run: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) await new Promise<void>(resolve => waiting.push(resolve))
    else active++
    try {
      return await run()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`fetch timed out after ${FETCH_TIMEOUT_MS} ms`))
    }, FETCH_TIMEOUT_MS)
  })
  const attempt = run(controller.signal)
  attempt.catch(() => {})
  return Promise.race([attempt, timedOut]).finally(() => clearTimeout(timer))
}

export function createResolver({ pageOrigin, fetcher }: { readonly pageOrigin: string; readonly fetcher: Fetcher }) {
  const maps = new Map<string, Promise<TraceMap | null>>()
  const limited = createLimiter(MAX_CONCURRENT_FETCHES)

  function fetchText(url: string): Promise<string> {
    return limited(() =>
      withTimeout(async signal => {
        const res = await fetcher(url, { signal })
        if (!res.ok) throw new Error(`${url} responded ${res.status}`)
        return res.text()
      }),
    )
  }

  async function loadMap(chunkUrl: string): Promise<TraceMap | null> {
    const js = await fetchText(chunkUrl)
    const ref = lastSourceMappingUrl(js)
    if (!ref) return null
    const mapUrl = new URL(ref, chunkUrl).href
    const text = await fetchText(mapUrl)
    const sourcesBase = mapUrl.startsWith('data:') ? chunkUrl : mapUrl
    return new FlattenMap(text, sourcesBase)
  }

  async function resolveClient(frame: Frame): Promise<SourceLoc | null> {
    let map = maps.get(frame.file)
    if (!map) {
      const loading: Promise<TraceMap | null> = loadMap(frame.file).catch(() => {
        if (maps.get(frame.file) === loading) maps.delete(frame.file)
        return null
      })
      map = loading
      maps.set(frame.file, loading)
    }
    const traced = await map
    if (!traced) return null
    const pos = originalPositionFor(traced, { line: frame.line, column: frame.column - 1 })
    if (pos.source === null) return null
    return { file: normalizeSource({ source: pos.source, pageOrigin }), line: pos.line, column: pos.column + 1 }
  }

  async function resolveServer(frame: Frame): Promise<SourceLoc | null> {
    const fileUrl = serverFileUrl(frame)
    try {
      const body = await limited(() =>
        withTimeout(async signal => {
          const res = await fetcher(`${pageOrigin}/__nextjs_original-stack-frames`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal,
            body: JSON.stringify({
              frames: [{ file: fileUrl, methodName: frame.fn, line1: frame.line, column1: frame.column }],
              isServer: true,
              isEdgeServer: false,
              isAppDirectory: true,
            }),
          })
          if (!res.ok) throw new Error(`dev server responded ${res.status}`)
          const json: unknown = await res.json()
          return json
        }),
      )
      const resolved = Array.isArray(body) ? nextFrameOf(body[0]) : null
      if (!resolved) return null
      const root = projectRootFromServerFile(fileUrl)
      const file = resolved.file.startsWith('/') || !root ? resolved.file : `${root}/${resolved.file}`
      return { file, line: resolved.line1, column: resolved.column1 }
    } catch {
      return null
    }
  }

  function resolve(frame: Frame | null): Promise<SourceLoc | null> {
    if (!frame) return Promise.resolve(null)
    return isServerFrame(frame) ? resolveServer(frame) : resolveClient(frame)
  }

  return {
    resolve,
    resolveAll(frames: readonly (Frame | null)[]): Promise<(SourceLoc | null)[]> {
      return Promise.all(frames.map(resolve))
    },
  }
}
