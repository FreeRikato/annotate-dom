import type {
  Accessibility, Ancestor, AxeViolation, ConsoleEvent, DesignTokens, Inspection, Interaction, NetworkEvent, OwnerSnapshot, QuerySnapshot, RecordedConsole,
  RecordedRequest, TokenValue,
} from './lib/types'

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
  const OVERLAY_TAG = 'annotate-dom-root'
  const FOCUSED_ATTR = 'data-annotate-dom-focused'
  const HOVERED_ATTR = 'data-annotate-dom-hovered'
  const SECRET = /token|secret|password|key|session|auth|cookie/i
  const JWT = /^eyJ[\w-]*\.[\w-]*\.[\w-]*$/
  const HTML_LIMIT = 10000
  const PROPS_LIMIT = 2000
  const MAX_OWNERS = 20
  const RECORDER_KEY = '__annotateDomRecorder'
  const MAX_QUERIES = 20
  const MAX_SHAPE_KEYS = 10
  const ERROR_LIMIT = 300
  const MAX_DIALOGS = 5
  const TOKEN_KEYS = ['color', 'background-color', 'padding', 'margin', 'gap', 'border-radius']
  const EMPTY_VALUES = new Set(['', '0px', 'none', 'normal', 'auto', 'transparent', 'rgba(0, 0, 0, 0)'])
  const TAG_ROLES: Record<string, string> = {
    button: 'button', select: 'combobox', textarea: 'textbox', img: 'img', nav: 'navigation', main: 'main',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  }
  const INPUT_ROLES: Record<string, string> = {
    button: 'button', submit: 'button', reset: 'button', checkbox: 'checkbox', radio: 'radio',
    range: 'slider', search: 'searchbox', text: 'textbox', email: 'textbox', tel: 'textbox', url: 'textbox', number: 'spinbutton',
  }

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

  const typedPasswords = new Set(
    Array.from(document.querySelectorAll('input[type="password"]'), input => (input instanceof HTMLInputElement ? input.value : '')).filter(v => v !== ''),
  )

  function serialize(value: unknown, depth: number, hideKeylessStrings = false): unknown {
    switch (typeof value) {
      case 'undefined':
        return '[undefined]'
      case 'string':
        if (hideKeylessStrings) return '[string]'
        if (typedPasswords.has(value) || JWT.test(value)) return '[redacted]'
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
      const items = value.slice(0, 5).map(v => serialize(v, depth + 1, hideKeylessStrings))
      if (value.length > 5) items.push(`...(+${value.length - 5} more)`)
      return items
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = SECRET.test(k) ? '[redacted]' : serialize(v, depth + 1)
    return out
  }

  function toJson(value: unknown, hideKeylessStrings = false): string {
    const json = JSON.stringify(serialize(value, 0, hideKeylessStrings)) ?? 'null'
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
    return values.length ? toJson(values, true) : null
  }

  function owners(start: unknown): OwnerSnapshot[] {
    const out: OwnerSnapshot[] = []
    let node = start
    while (isRecord(node) && out.length < MAX_OWNERS) {
      if (typeof node.tag === 'number') {
        out.push({
          name: typeName(node.type),
          env: 'client',
          stack: stackOf(node._debugStack),
          props: toJson(node.memoizedProps),
          state: hookState(node),
        })
        node = node._debugOwner
      } else {
        out.push({
          name: typeof node.name === 'string' ? node.name : 'Anonymous',
          env: 'server',
          stack: stackOf(node.debugStack),
          props: node.props !== undefined ? toJson(node.props) : null,
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
      if (attr.name.startsWith('data-annotate-dom-')) continue
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
    const isConsoleEntry = (entry: unknown): entry is RecordedConsole =>
      isRecord(entry) && typeof entry.at === 'number' && typeof entry.message === 'string'
    const isRequestEntry = (entry: unknown): entry is RecordedRequest =>
      isRecord(entry) && typeof entry.at === 'number' && typeof entry.method === 'string' && typeof entry.url === 'string'
      && (entry.status === null || typeof entry.status === 'number') && typeof entry.durationMs === 'number'
    const pinnedAt = Date.now()
    return {
      console: events.console.filter(isConsoleEntry).map(({ at, message }) => ({ offsetMs: at - pinnedAt, message })),
      network: events.network.filter(isRequestEntry).map(({ at, ...rest }) => ({ offsetMs: at - pinnedAt, ...rest })),
    }
  }

  function dataShape(data: unknown): string {
    if (data === undefined) return 'undefined'
    if (data === null) return 'null'
    if (Array.isArray(data)) return `array(${data.length})`
    if (!isRecord(data)) return typeof data
    const keys = Object.keys(data)
    return `object{${keys.slice(0, MAX_SHAPE_KEYS).join(',')}${keys.length > MAX_SHAPE_KEYS ? ',...' : ''}}`
  }

  function queryCacheOf(start: Record<string, unknown>): unknown[] {
    for (let node: unknown = start; isRecord(node); node = node.return) {
      const client = isRecord(node.memoizedProps) ? node.memoizedProps.value : null
      if (!isRecord(client) || typeof client.getQueryCache !== 'function') continue
      const cache: unknown = client.getQueryCache()
      const all = isRecord(cache) && typeof cache.getAll === 'function' ? cache.getAll() : null
      return Array.isArray(all) ? all : []
    }
    return []
  }

  function querySnapshots(start: Record<string, unknown> | null): QuerySnapshot[] {
    if (!start) return []
    const out: QuerySnapshot[] = []
    for (const query of queryCacheOf(start).slice(0, MAX_QUERIES)) {
      if (!isRecord(query) || !isRecord(query.state)) continue
      const { status, fetchStatus, dataUpdatedAt, error, data } = query.state
      out.push({
        key: toJson(query.queryKey),
        status: String(status),
        fetchStatus: String(fetchStatus),
        dataUpdatedAt: typeof dataUpdatedAt === 'number' ? dataUpdatedAt : 0,
        error: isRecord(error) && typeof error.message === 'string' ? error.message.slice(0, ERROR_LIMIT) : null,
        dataShape: dataShape(data),
      })
    }
    return out
  }

  function interactionState(): Interaction {
    const isApp = (node: Element | null | undefined): node is Element =>
      !!node && node !== document.body && node !== document.documentElement && node.tagName.toLowerCase() !== OVERLAY_TAG
    const focus = document.querySelector(`[${FOCUSED_ATTR}]`) ?? document.activeElement
    const hovered = document.querySelector(`[${HOVERED_ATTR}]`) ?? Array.from(document.querySelectorAll(':hover')).filter(isApp).at(-1)
    return {
      focused: isApp(focus) ? selectorFor(focus) : null,
      hovered: isApp(hovered) ? selectorFor(hovered) : null,
      dialogs: Array.from(document.querySelectorAll('[role="dialog"], dialog[open], [open]')).slice(0, MAX_DIALOGS).map(selectorFor),
      searchParams: Array.from(new URLSearchParams(location.search), ([key, value]) => ({
        key,
        value: SECRET.test(key) ? '[redacted]' : value,
      })),
    }
  }

  function isIterable(value: unknown): value is Iterable<unknown> {
    return isRecord(value) && typeof Reflect.get(value, Symbol.iterator) === 'function'
  }

  function customProperties(): string[] {
    const names = new Set<string>()
    const visit = (rules: Iterable<unknown>) => {
      for (const rule of rules) {
        if (!isRecord(rule)) continue
        const style = rule.style
        if (isRecord(style) && typeof style.length === 'number') {
          for (let i = 0; i < style.length; i++) {
            const name: unknown = Reflect.get(style, i)
            if (typeof name === 'string' && name.startsWith('--')) names.add(name)
          }
        }
        if (isIterable(rule.cssRules)) visit(rule.cssRules)
      }
    }
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visit(sheet.cssRules)
      } catch {
        continue
      }
    }
    return Array.from(names)
  }

  function designTokens(node: Element): DesignTokens {
    const root = getComputedStyle(document.documentElement)
    const probe = document.createElement('div')
    probe.style.display = 'none'
    document.body.append(probe)
    const resolved = (prop: string, value: string): string | null => {
      probe.style.removeProperty(prop)
      probe.style.setProperty(prop, value)
      return probe.style.getPropertyValue(prop) === '' ? null : getComputedStyle(probe).getPropertyValue(prop)
    }
    const tokens = customProperties().map(name => ({ name, value: root.getPropertyValue(name).trim() }))
    const computed = getComputedStyle(node)
    const values: TokenValue[] = []
    for (const prop of TOKEN_KEYS) {
      const value = computed.getPropertyValue(prop)
      if (EMPTY_VALUES.has(value)) continue
      const match = tokens.find(t => resolved(prop, t.value) === value)
      values.push({ prop, value, token: match ? `var(${match.name})` : null })
    }
    probe.remove()
    return { classes: Array.from(node.classList), values }
  }

  function normalized(text: string | null): string {
    return (text ?? '').replace(/\s+/g, ' ').trim()
  }

  function roleOf(node: Element): string | null {
    const explicit = node.getAttribute('role')?.trim().split(/\s+/)[0]
    if (explicit) return explicit
    const tag = node.tagName.toLowerCase()
    if (tag === 'a') return node.hasAttribute('href') ? 'link' : null
    if (tag === 'input') return INPUT_ROLES[(node.getAttribute('type') ?? 'text').toLowerCase()] ?? null
    return TAG_ROLES[tag] ?? null
  }

  function labelOf(node: Element): string {
    const aria = normalized(node.getAttribute('aria-label'))
    if (aria) return aria
    const ids = node.getAttribute('aria-labelledby')?.split(/\s+/) ?? []
    const referenced = ids.map(id => normalized(document.getElementById(id)?.textContent ?? '')).join(' ').trim()
    if (referenced) return referenced
    if (!(node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement)) return ''
    return normalized(Array.from(node.labels ?? []).map(l => l.textContent).join(' '))
  }

  function nameOf(node: Element): string {
    const label = labelOf(node)
    if (label) return label
    if (node instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(node.type)) return normalized(node.value)
    if (node instanceof HTMLImageElement) return normalized(node.alt)
    return normalized(node.textContent)
  }

  function containsText(haystack: string, needle: string): boolean {
    return haystack.toLowerCase().includes(needle.toLowerCase())
  }

  function sourceString(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  }

  function locatorFor(node: Element): string | null {
    const all = Array.from(document.querySelectorAll('*'))
    const isOnly = (matching: (other: Element) => boolean) => {
      const hits = all.filter(matching)
      return hits.length === 1 && hits[0] === node
    }
    const role = roleOf(node)
    const name = nameOf(node)
    if (role && name && isOnly(o => roleOf(o) === role && containsText(nameOf(o), name))) {
      return `getByRole(${sourceString(role)}, { name: ${sourceString(name)} })`
    }
    const label = labelOf(node)
    if (label && isOnly(o => containsText(labelOf(o), label))) return `getByLabel(${sourceString(label)})`
    const text = normalized(node.textContent)
    const ownText = (o: Element) => normalized(o.textContent) === text && !Array.from(o.children).some(c => normalized(c.textContent) === text)
    if (text && isOnly(ownText)) return `getByText(${sourceString(text)}, { exact: true })`
    const testId = node.getAttribute('data-testid')
    if (testId && isOnly(o => o.getAttribute('data-testid') === testId)) return `getByTestId(${sourceString(testId)})`
    return null
  }

  function statesOf(node: Element): string[] {
    const states: string[] = []
    const aria = (name: string) => node.getAttribute(name)
    const field = node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement ? node : null
    const textField = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node : null
    const disabled = field?.disabled === true || ((node instanceof HTMLButtonElement || node instanceof HTMLFieldSetElement || node instanceof HTMLOptionElement) && node.disabled)
    if (disabled || aria('aria-disabled') === 'true') states.push('disabled')
    if ((node instanceof HTMLInputElement && node.checked) || aria('aria-checked') === 'true') states.push('checked')
    if (aria('aria-pressed') === 'true') states.push('pressed')
    if (aria('aria-selected') === 'true') states.push('selected')
    if (aria('aria-expanded') === 'true') states.push('expanded')
    if (aria('aria-expanded') === 'false') states.push('collapsed')
    if (field?.required === true || aria('aria-required') === 'true') states.push('required')
    if (textField?.readOnly === true || aria('aria-readonly') === 'true') states.push('readonly')
    if (aria('aria-invalid') === 'true') states.push('invalid')
    return states
  }

  function accessibility(node: Element): Accessibility {
    return { role: roleOf(node), name: nameOf(node), states: statesOf(node), violations: [] }
  }

  const ancestors: Ancestor[] = []
  for (let p = el.parentElement; p && p !== document.body && ancestors.length < 2; p = p.parentElement) {
    ancestors.push({ selector: describe(p), styles: pick(p, LAYOUT_KEYS) })
  }

  const rect = el.getBoundingClientRect()
  const html = el.outerHTML.replace(new RegExp(` data-annotate-dom-(?:target|focused|hovered)="[^"]*"`, 'g'), '')
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
    queries: querySnapshots(fiber),
    interaction: interactionState(),
    tokens: designTokens(el),
    locator: locatorFor(el),
    a11y: accessibility(el),
  }
}

export async function axeViolations(marker: string): Promise<AxeViolation[]> {
  const el = document.querySelector(`[data-annotate-dom-target="${marker}"]`)
  const axe: unknown = Reflect.get(window, 'axe')
  const run: unknown = typeof axe === 'object' && axe !== null ? Reflect.get(axe, 'run') : null
  if (!el || typeof run !== 'function') return []
  const results: unknown = await run.call(axe, el)
  const found: unknown = typeof results === 'object' && results !== null ? Reflect.get(results, 'violations') : null
  if (!Array.isArray(found)) return []
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
  const out: AxeViolation[] = []
  for (const violation of found) {
    if (!isRecord(violation)) continue
    const nodes: unknown = violation.nodes
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!isRecord(node)) continue
      out.push({
        id: String(violation.id),
        impact: typeof violation.impact === 'string' ? violation.impact : null,
        selector: Array.isArray(node.target) ? node.target.join(' ') : '',
      })
    }
  }
  return out.slice(0, 20)
}
