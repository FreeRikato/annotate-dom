import type { Ancestor, ConsoleEvent, Inspection, NetworkEvent, OwnerSnapshot } from './lib/types'

export function inspectElement(marker: string): Inspection | null {
  const ATTR = 'data-annotate-dom-target'
  const STYLE_KEYS = [
    'display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color',
    'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'border', 'border-radius',
    'box-shadow', 'opacity', 'visibility', 'z-index', 'overflow', 'cursor', 'pointer-events',
    'flex-direction', 'justify-content', 'align-items', 'gap',
  ]
  const LAYOUT_KEYS = [
    'display', 'position', 'width', 'height', 'padding', 'flex-direction', 'justify-content',
    'align-items', 'gap', 'grid-template-columns', 'overflow',
  ]
  const SECRET = /token|secret|password|key|session|auth|cookie/i
  const HTML_LIMIT = 10000
  const PROPS_LIMIT = 2000
  const MAX_OWNERS = 6
  const OWNERS_WITH_DATA = 3
  const RECORDER_KEY = '__annotateDomRecorder'

  const el = document.querySelector(`[${ATTR}="${marker}"]`)
  if (!el) return null

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
  }

  function typeName(type: unknown): string {
    if (typeof type === 'string') return type
    if (typeof type === 'function') {
      const display: unknown = Reflect.get(type, 'displayName')
      return typeof display === 'string' ? display : type.name || 'Anonymous'
    }
    if (isRecord(type)) {
      if (typeof type.displayName === 'string') return type.displayName
      if (type.render !== undefined) return typeName(type.render)
      if (type.type !== undefined) return typeName(type.type)
    }
    return 'Anonymous'
  }

  function serialize(value: unknown, depth: number): unknown {
    switch (typeof value) {
      case 'undefined':
        return '[undefined]'
      case 'string':
        return value.length > 200 ? `${value.slice(0, 200)}...(+${value.length - 200} chars)` : value
      case 'number':
      case 'boolean':
        return value
      case 'bigint':
        return `${value}n`
      case 'symbol':
        return value.toString()
      case 'function':
        return `[function ${value.name || 'anonymous'}]`
    }
    if (value === null) return null
    if (value instanceof Element) return `<${value.tagName.toLowerCase()}>`
    if (value instanceof Date) return value.toISOString()
    if (value instanceof Map) return `[Map(${value.size})]`
    if (value instanceof Set) return `[Set(${value.size})]`
    if (value instanceof Promise) return '[Promise]'
    if (!isRecord(value)) return String(value)
    if ('$$typeof' in value) return `<${typeName(value.type)} />`
    if (depth >= 2) return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]'
    if (Array.isArray(value)) {
      const items = value.slice(0, 5).map(v => serialize(v, depth + 1))
      if (value.length > 5) items.push(`...(+${value.length - 5} more)`)
      return items
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = SECRET.test(k) ? '[redacted]' : serialize(v, depth + 1)
    return out
  }

  function toJson(value: unknown): string {
    const json = JSON.stringify(serialize(value, 0)) ?? 'null'
    return json.length > PROPS_LIMIT ? `${json.slice(0, PROPS_LIMIT)}...(truncated)` : json
  }

  function stackOf(value: unknown): string | null {
    if (!isRecord(value)) return null
    const stack: unknown = value.stack
    return typeof stack === 'string' ? stack : null
  }

  function hookState(fiber: Record<string, unknown>): string | null {
    if (fiber.tag === 1) {
      const instance = fiber.stateNode
      return isRecord(instance) && instance.state !== undefined ? toJson(instance.state) : null
    }
    const values: unknown[] = []
    let hook: unknown = fiber.memoizedState
    for (let i = 0; isRecord(hook) && i < 50; i++) {
      const queue = hook.queue
      if (isRecord(queue) && 'lastRenderedReducer' in queue) values.push(hook.memoizedState)
      hook = hook.next
    }
    return values.length ? toJson(values) : null
  }

  function owners(start: unknown): OwnerSnapshot[] {
    const out: OwnerSnapshot[] = []
    let node = start
    while (isRecord(node) && out.length < MAX_OWNERS) {
      const withData = out.length < OWNERS_WITH_DATA
      if (typeof node.tag === 'number') {
        out.push({
          name: typeName(node.type),
          env: 'client',
          stack: stackOf(node._debugStack),
          props: withData ? toJson(node.memoizedProps) : null,
          state: withData ? hookState(node) : null,
        })
        node = node._debugOwner
      } else {
        out.push({
          name: typeof node.name === 'string' ? node.name : 'Anonymous',
          env: 'server',
          stack: stackOf(node.debugStack),
          props: withData && node.props !== undefined ? toJson(node.props) : null,
          state: null,
        })
        node = node.owner
      }
    }
    return out
  }

  function fiberOf(node: Element): Record<string, unknown> | null {
    const key = Object.keys(node).find(k => k.startsWith('__reactFiber$'))
    if (!key) return null
    const fiber: unknown = Reflect.get(node, key)
    return isRecord(fiber) ? fiber : null
  }

  function quote(value: string): string {
    return JSON.stringify(value)
  }

  function selectorFor(node: Element): string {
    if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) return `#${CSS.escape(node.id)}`
    const parts: string[] = []
    let cur: Element | null = node
    while (cur && cur !== document.documentElement && parts.length < 8) {
      let part = cur.tagName.toLowerCase()
      const hint = ['data-testid', 'data-slot', 'name', 'aria-label', 'role'].find(a => cur?.hasAttribute(a))
      if (hint) part += `[${hint}=${quote(cur.getAttribute(hint) ?? '')}]`
      const parent: Element | null = cur.parentElement
      const tag = cur.tagName
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === tag)
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`
      }
      parts.unshift(part)
      const selector = parts.join(' > ')
      if (document.querySelectorAll(selector).length === 1) return selector
      cur = parent
    }
    return parts.join(' > ')
  }

  function describe(node: Element): string {
    const classes = Array.from(node.classList).slice(0, 8).map(c => `.${c}`).join('')
    return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${classes}`
  }

  function pick(node: Element, keys: readonly string[]): Record<string, string> {
    const computed = getComputedStyle(node)
    const out: Record<string, string> = {}
    for (const k of keys) out[k] = computed.getPropertyValue(k)
    return out
  }

  function attributes(node: Element): Record<string, string> {
    const out: Record<string, string> = {}
    for (const attr of Array.from(node.attributes)) {
      if (attr.name === ATTR) continue
      out[attr.name] = attr.value.length > 300 ? `${attr.value.slice(0, 300)}...` : attr.value
    }
    if (node instanceof HTMLInputElement) {
      out['(value)'] = node.type === 'password' ? '[redacted]' : node.value
      if (node.type === 'checkbox' || node.type === 'radio') out['(checked)'] = String(node.checked)
    }
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) out['(value)'] = node.value
    if (
      node instanceof HTMLButtonElement || node instanceof HTMLInputElement ||
      node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement
    ) out['(disabled)'] = String(node.disabled)
    return out
  }

  function recorded(): { console: ConsoleEvent[]; network: NetworkEvent[] } {
    const recorder: unknown = Reflect.get(window, RECORDER_KEY)
    const read = isRecord(recorder) ? recorder.read : null
    const events: unknown = typeof read === 'function' ? read.call(recorder) : null
    if (!isRecord(events) || !Array.isArray(events.console) || !Array.isArray(events.network)) {
      return { console: [], network: [] }
    }
    const pinnedAt = Date.now()
    return {
      console: events.console.map(({ at, message }) => ({ offsetMs: at - pinnedAt, message })),
      network: events.network.map(({ at, ...rest }) => ({ offsetMs: at - pinnedAt, ...rest })),
    }
  }

  const ancestors: Ancestor[] = []
  for (let p = el.parentElement; p && p !== document.body && ancestors.length < 2; p = p.parentElement) {
    ancestors.push({ selector: describe(p), styles: pick(p, LAYOUT_KEYS) })
  }

  const rect = el.getBoundingClientRect()
  const html = el.outerHTML.replace(new RegExp(` ${ATTR}="[^"]*"`), '')
  const fiber = fiberOf(el)

  return {
    selector: selectorFor(el),
    tag: el.tagName.toLowerCase(),
    html: html.length > HTML_LIMIT ? html.slice(0, HTML_LIMIT) : html,
    htmlTruncated: html.length > HTML_LIMIT,
    text: el instanceof HTMLElement ? el.innerText.trim().slice(0, 300) : '',
    box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    styles: pick(el, STYLE_KEYS),
    attributes: attributes(el),
    ancestors,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    react: fiber ? { elementStack: stackOf(fiber._debugStack), owners: owners(fiber._debugOwner) } : null,
    ...recorded(),
  }
}
