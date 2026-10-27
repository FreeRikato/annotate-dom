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

type MapLoad = { readonly traced: Promise<TraceMap | null>; readonly join: (deadline: AbortSignal) => void }

export const MAX_CONCURRENT_FETCHES = 3
export const FETCH_TIMEOUT_MS = 8000
export const RESOLVE_DEADLINE_MS = 8000

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

export function createResolver({
  pageOrigin,
  fetcher,
  basePath = '',
}: {
  readonly pageOrigin: string
  readonly fetcher: Fetcher
  readonly basePath?: string
}) {
  const maps = new Map<string, MapLoad>()
  const limited = createLimiter(MAX_CONCURRENT_FETCHES)

  function fetchText(url: string, isAwaited: () => boolean): Promise<string> {
    return limited(() =>
      withTimeout(async signal => {
        if (!isAwaited()) throw new Error(`no resolve still waits for ${url}`)
        const res = await fetcher(url, { signal })
        if (!res.ok) throw new Error(`${url} responded ${res.status}`)
        return res.text()
      }),
    )
  }

  async function loadMap(chunkUrl: string, isAwaited: () => boolean): Promise<TraceMap | null> {
    const js = await fetchText(chunkUrl, isAwaited)
    const ref = lastSourceMappingUrl(js)
    if (!ref) return null
    const mapUrl = new URL(ref, chunkUrl).href
    const text = await fetchText(mapUrl, isAwaited)
    const sourcesBase = mapUrl.startsWith('data:') ? chunkUrl : mapUrl
    return new FlattenMap(text, sourcesBase)
  }

  function startMapLoad(chunkUrl: string, deadline: AbortSignal): MapLoad {
    let waiting = 0
    const join = (callerDeadline: AbortSignal) => {
      waiting++
      callerDeadline.addEventListener('abort', () => waiting--, { once: true })
    }
    join(deadline)
    const traced: Promise<TraceMap | null> = loadMap(chunkUrl, () => waiting > 0).catch(() => {
      if (maps.get(chunkUrl)?.traced === traced) maps.delete(chunkUrl)
      return null
    })
    return { traced, join }
  }

  async function resolveClient(frame: Frame, deadline: AbortSignal): Promise<SourceLoc | null> {
    let load = maps.get(frame.file)
    if (load) load.join(deadline)
    else {
      load = startMapLoad(frame.file, deadline)
      maps.set(frame.file, load)
    }
    const traced = await load.traced
    if (!traced) return null
    const pos = originalPositionFor(traced, { line: frame.line, column: frame.column - 1 })
    if (pos.source === null) return null
    return { file: normalizeSource({ source: pos.source, pageOrigin }), line: pos.line, column: pos.column + 1 }
  }

  async function resolveServerFrames(frames: readonly Frame[], deadline: AbortSignal): Promise<(SourceLoc | null)[]> {
    const fileUrls = frames.map(serverFileUrl)
    try {
      const body = await limited(() =>
        withTimeout(async signal => {
          deadline.throwIfAborted()
          const res = await fetcher(`${pageOrigin}${basePath}/__nextjs_original-stack-frames`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal,
            body: JSON.stringify({
              frames: frames.map((frame, i) => ({ file: fileUrls[i], methodName: frame.fn, line1: frame.line, column1: frame.column })),
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
      return fileUrls.map((fileUrl, i) => {
        const resolved = Array.isArray(body) ? nextFrameOf(body[i]) : null
        if (!resolved) return null
        const root = projectRootFromServerFile(fileUrl)
        const file = resolved.file.startsWith('/') || !root ? resolved.file : `${root}/${resolved.file}`
        return { file, line: resolved.line1, column: resolved.column1 }
      })
    } catch {
      return frames.map(() => null)
    }
  }

  async function resolveAll(frames: readonly (Frame | null)[]): Promise<(SourceLoc | null)[]> {
    const overall = new AbortController()
    const timer = setTimeout(() => overall.abort(), RESOLVE_DEADLINE_MS)
    const expired = new Promise<null>(resolve => overall.signal.addEventListener('abort', () => resolve(null)))
    const bounded = <T,>(work: Promise<T>) => Promise.race([work, expired])
    const server = frames.flatMap((frame, i) => (frame && isServerFrame(frame) ? [{ frame, i }] : []))
    try {
      const serverResults = server.length
        ? bounded(resolveServerFrames(server.map(s => s.frame), overall.signal))
        : Promise.resolve([])
      const results = await Promise.all(
        frames.map(frame => (frame && !isServerFrame(frame) ? bounded(resolveClient(frame, overall.signal)) : null)),
      )
      ;((await serverResults) ?? []).forEach((loc, k) => {
        results[server[k].i] = loc
      })
      return results
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    resolve: async (frame: Frame | null) => (await resolveAll([frame]))[0],
    resolveAll,
  }
}
