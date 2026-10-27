import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Inspection } from '../src/lib/types'
import type { StoredRecapture } from './batch'
import { addRecapture, locate } from './store'

export type RecaptureResult =
  | { readonly reqId: string; readonly ok: true; readonly crop: string; readonly inspection: Inspection }
  | { readonly reqId: string; readonly ok: false; readonly reason: string }

export type ExtensionSocket = { readonly send: (data: string) => unknown }

export type ExtensionLink = {
  readonly connect: (socket: ExtensionSocket) => void
  readonly disconnect: (socket: ExtensionSocket) => void
  readonly deliver: (result: RecaptureResult) => void
  readonly request: (frame: { readonly url: string; readonly selector: string; readonly locator: string | null }) => Promise<RecaptureResult>
}

export type RecaptureOutcome =
  | {
    readonly ok: true
    readonly before: string
    readonly after: string
    readonly styleDiff: StoredRecapture['styleDiff']
    readonly htmlChanged: boolean
  }
  | { readonly ok: false; readonly error: string }

const RESPONSE_TIMEOUT_MS = 30_000

export function isRecaptureResult(frame: Record<string, unknown>): frame is RecaptureResult {
  return typeof frame.reqId === 'string' && (frame.ok === true
    ? typeof frame.crop === 'string' && typeof frame.inspection === 'object' && frame.inspection !== null
    : frame.ok === false && typeof frame.reason === 'string')
}

export function createExtensionLink(timeoutMs = RESPONSE_TIMEOUT_MS): ExtensionLink {
  let current: ExtensionSocket | null = null
  const pending = new Map<string, (result: RecaptureResult) => void>()
  return {
    connect: socket => { current = socket },
    disconnect: socket => { if (current === socket) current = null },
    deliver: result => pending.get(result.reqId)?.(result),
    request: frame => {
      const socket = current
      if (!socket) return Promise.resolve({ reqId: '', ok: false, reason: 'extension not connected' })
      const reqId = crypto.randomUUID()
      return new Promise(resolve => {
        const settle = (result: RecaptureResult) => {
          clearTimeout(timer)
          pending.delete(reqId)
          resolve(result)
        }
        const timer = setTimeout(() => settle({ reqId, ok: false, reason: 'extension did not respond' }), timeoutMs)
        pending.set(reqId, settle)
        socket.send(JSON.stringify({ type: 'recapture', reqId, ...frame }))
      })
    },
  }
}

export function diffStyles(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): StoredRecapture['styleDiff'] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(prop => {
    const was = before[prop] ?? ''
    const now = after[prop] ?? ''
    return was === now ? [] : [{ prop, before: was, after: now }]
  })
}

export async function recapture({ home, id, project, link, now }: {
  readonly home: string
  readonly id: string
  readonly project?: string
  readonly link: ExtensionLink
  readonly now: number
}): Promise<RecaptureOutcome> {
  const found = await locate({ home, id, project })
  if (!found) return { ok: false, error: `annotation not found: ${id}` }
  const { pin, dir } = found
  const result = await link.request({ url: pin.url, selector: pin.inspection.selector, locator: pin.inspection.locator ?? null })
  if (!result.ok) return { ok: false, error: result.reason }
  const afterFile = `pin-${pin.n}-after.png`
  await writeFile(join(dir, afterFile), Buffer.from(result.crop.slice(result.crop.indexOf(',') + 1), 'base64'))
  const styleDiff = diffStyles(pin.inspection.styles, result.inspection.styles)
  const htmlChanged = pin.inspection.html !== result.inspection.html
  await addRecapture({ found, recapture: { at: now, afterFile, styleDiff, htmlChanged } })
  return { ok: true, before: join(dir, pin.cropFile), after: join(dir, afterFile), styleDiff, htmlChanged }
}
