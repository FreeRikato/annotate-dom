import type { RecordedConsole, RecordedEvents, RecordedRequest } from './lib/types'

export const RECORDER_KEY = '__annotateDomRecorder'

const WINDOW_MS = 30_000
const SLOW_MS = 1000
const TEXT_LIMIT = 300
const FIRST_ERROR_STATUS = 400

type XhrOpenRest = [async?: boolean, username?: string | null, password?: string | null]

type XhrLike = {
  open(method: string, url: string | URL, ...rest: XhrOpenRest): void
  send(body?: Document | XMLHttpRequestBodyInit | null): void
  addEventListener(type: 'loadend', fn: () => void): void
  readonly status: number
}

export type RecorderTarget = {
  console: { error: (...args: unknown[]) => void }
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  XMLHttpRequest: { new (): XhrLike }
  addEventListener(type: 'error' | 'unhandledrejection', fn: (event: ErrorEvent | PromiseRejectionEvent) => void): void
}

const SECRET_PARAM = /([?&;\s]|^)([\w.-]*(?:token|secret|password|key|session|auth|cookie)[\w.-]*)=[^&\s'"]*/gi

function clip(text: string): string {
  return text.replace(SECRET_PARAM, '$1$2=[redacted]').slice(0, TEXT_LIMIT)
}

function describeValue(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function methodOf(input: string | URL | Request, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
}

export function installRecorder(target: RecorderTarget, now: () => number = Date.now): void {
  if (Reflect.has(target, RECORDER_KEY)) return

  const consoleEvents: RecordedConsole[] = []
  const requests: RecordedRequest[] = []

  function prune<T extends { readonly at: number }>(list: T[]): void {
    const cutoff = now() - WINDOW_MS
    const stale = list.findIndex(e => e.at >= cutoff)
    list.splice(0, stale === -1 ? list.length : stale)
  }

  function logConsole(message: string): void {
    consoleEvents.push({ at: now(), message: clip(message) })
    prune(consoleEvents)
  }

  function logRequest(method: string, url: string, status: number | null, startedAt: number): void {
    const at = now()
    const durationMs = at - startedAt
    const failed = status === null || status >= FIRST_ERROR_STATUS
    if (failed || durationMs > SLOW_MS) requests.push({ at, method, url: clip(url), status, durationMs })
    prune(requests)
  }

  const originalError = target.console.error
  target.console.error = (...args: unknown[]) => {
    logConsole(args.map(describeValue).join(' '))
    originalError.apply(target.console, args)
  }

  function logPageError(event: ErrorEvent | PromiseRejectionEvent): void {
    logConsole('reason' in event ? describeValue(event.reason) : event.message || 'Script error')
  }
  target.addEventListener('error', logPageError)
  target.addEventListener('unhandledrejection', logPageError)

  const originalFetch = target.fetch
  target.fetch = async (input, init) => {
    const startedAt = now()
    const method = methodOf(input, init)
    const url = urlOf(input)
    try {
      const response = await originalFetch.call(target, input, init)
      logRequest(method, url, response.status, startedAt)
      return response
    } catch (error: unknown) {
      logRequest(method, url, null, startedAt)
      throw error
    }
  }

  const pending = new WeakMap<object, { method: string; url: string }>()
  const proto = target.XMLHttpRequest.prototype
  const originalOpen = proto.open
  const originalSend = proto.send
  proto.open = function (this: XhrLike, method: string, url: string | URL, ...rest: XhrOpenRest) {
    pending.set(this, { method: method.toUpperCase(), url: String(url) })
    originalOpen.call(this, method, url, ...rest)
  }
  proto.send = function (this: XhrLike, body?: Document | XMLHttpRequestBodyInit | null) {
    const request = pending.get(this)
    const startedAt = now()
    if (request) this.addEventListener('loadend', () => logRequest(request.method, request.url, this.status || null, startedAt))
    originalSend.call(this, body)
  }

  Object.defineProperty(target, RECORDER_KEY, {
    value: {
      read(): RecordedEvents {
        prune(consoleEvents)
        prune(requests)
        return { console: [...consoleEvents], network: [...requests] }
      },
    },
    enumerable: false,
  })
}

if (typeof window !== 'undefined') installRecorder(window)
