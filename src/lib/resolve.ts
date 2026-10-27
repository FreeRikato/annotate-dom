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

export function createResolver({ pageOrigin, fetcher }: { readonly pageOrigin: string; readonly fetcher: Fetcher }) {
  const maps = new Map<string, Promise<TraceMap | null>>()

  async function loadMap(chunkUrl: string): Promise<TraceMap | null> {
    try {
      const js = await (await fetcher(chunkUrl)).text()
      const ref = lastSourceMappingUrl(js)
      if (!ref) return null
      const mapUrl = new URL(ref, chunkUrl).href
      const text = await (await fetcher(mapUrl)).text()
      const sourcesBase = mapUrl.startsWith('data:') ? chunkUrl : mapUrl
      return new FlattenMap(text, sourcesBase)
    } catch {
      return null
    }
  }

  async function resolveClient(frame: Frame): Promise<SourceLoc | null> {
    let map = maps.get(frame.file)
    if (!map) {
      map = loadMap(frame.file)
      maps.set(frame.file, map)
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
      const res = await fetcher(`${pageOrigin}/__nextjs_original-stack-frames`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          frames: [{ file: fileUrl, methodName: frame.fn, line1: frame.line, column1: frame.column }],
          isServer: true,
          isEdgeServer: false,
          isAppDirectory: true,
        }),
      })
      if (!res.ok) return null
      const body: unknown = await res.json()
      const resolved = Array.isArray(body) ? nextFrameOf(body[0]) : null
      if (!resolved) return null
      const root = projectRootFromServerFile(fileUrl)
      const file = resolved.file.startsWith('/') || !root ? resolved.file : `${root}/${resolved.file}`
      return { file, line: resolved.line1, column: resolved.column1 }
    } catch {
      return null
    }
  }

  return {
    resolve(frame: Frame | null): Promise<SourceLoc | null> {
      if (!frame) return Promise.resolve(null)
      return isServerFrame(frame) ? resolveServer(frame) : resolveClient(frame)
    },
  }
}
