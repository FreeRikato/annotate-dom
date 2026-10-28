import type { Batch, Box, Inspection, Pin } from './types'

export const MARKER_ATTR = 'data-annotate-dom-target'
export const FOCUSED_ATTR = 'data-annotate-dom-focused'
export const HOVERED_ATTR = 'data-annotate-dom-hovered'

export type Request =
  | { readonly kind: 'inspect'; readonly marker: string }
  | { readonly kind: 'capture'; readonly rect: Box; readonly viewportWidth: number }
  | { readonly kind: 'get-batch' }
  | { readonly kind: 'add-pin'; readonly pin: Pin; readonly viewport: string; readonly dpr: number; readonly rects: Readonly<Record<string, Box>> }
  | { readonly kind: 'delete-pin'; readonly id: string }
  | { readonly kind: 'export'; readonly origin: string }
  | { readonly kind: 'quick-grab'; readonly pin: Pin; readonly origin: string }
  | { readonly kind: 'undo' }
  | { readonly kind: 'daemon-status' }
  | { readonly kind: 'send'; readonly origin: string }

export type Responses = {
  readonly inspect: Inspection | null
  readonly capture: { readonly viewport: string; readonly crop: string; readonly dpr: number }
  readonly 'get-batch': Batch
  readonly 'add-pin': Batch
  readonly 'delete-pin': Batch
  readonly export: { readonly markdown: string; readonly count: number }
  readonly 'quick-grab': { readonly markdown: string }
  readonly undo: Batch
  readonly 'daemon-status': { readonly connected: boolean }
  readonly send: { readonly count: number; readonly folder: string; readonly prompt: string }
}

export type Reply<K extends Request['kind']> =
  | { readonly ok: true; readonly data: Responses[K] }
  | { readonly ok: false; readonly error: string }

const KINDS: ReadonlySet<string> = new Set<Request['kind']>(['inspect', 'capture', 'get-batch', 'add-pin', 'delete-pin', 'export', 'quick-grab', 'undo', 'daemon-status', 'send'])

export function hasRequestKind(value: unknown): value is Request {
  return typeof value === 'object' && value !== null && 'kind' in value && typeof value.kind === 'string' && KINDS.has(value.kind)
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`)
}
