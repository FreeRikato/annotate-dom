import type {
  Accessibility, Ancestor, AxeViolation, BoxModel, ConsoleEvent, CssVariable, DesignTokens, Inspection, Interaction, NetworkEvent, OwnerSnapshot, QuerySnapshot, RecordedConsole,
  RecordedRequest, Sides, TokenValue,
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
  const SECRET_SUBSTRING = /token|secret|password|key|session|auth|cookie|pwd|passcode|credential/i
  const SECRET_WORDS = new Set(['pin', 'otp'])
  const XHTML = 'http://www.w3.org/1999/xhtml'
  const VAR_REFERENCE = /var\(\s*(--[^\s,)]+)/g
  const JWT = /^eyJ[\w-]*\.[\w-]*\.[\w-]*$/
  const HTML_LIMIT = 10000
  const PROPS_LIMIT = 2000
  const MAX_OWNERS = 20
  const RECORDER_KEY = '__annotateDomRecorder'
  const MAX_QUERIES = 20
  const MAX_SHAPE_KEYS = 10
  const ERROR_LIMIT = 300
  const MAX_DIALOGS = 5
  const MAX_CSS_VARIABLES = 30
  const TAILWIND_INTERNAL_PREFIX = '--tw-'
  const MIN_CONTAINED_SECRET = 8
  const SELECTION_LIMIT = 500
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

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
  }

  function isElement(value: unknown): value is Element {
    return isRecord(value) && value.nodeType === 1
  }

  function isDocument(value: unknown): value is Document {
    return isRecord(value) && value.nodeType === 9
  }

  function isShadowRoot(value: unknown): value is ShadowRoot {
    return isRecord(value) && value.nodeType === 11 && isElement(value.host)
  }

  function isParentNode(value: unknown): value is ParentNode {
    return isRecord(value) && typeof value.querySelectorAll === 'function'
  }

  function hasTag(node: Element, tag: string): boolean {
    return node.localName === tag && node.namespaceURI === XHTML
  }

  function isHtml(node: Element): node is HTMLElement {
    return node.namespaceURI === XHTML
  }

  function isInput(node: Element): node is HTMLInputElement {
    return hasTag(node, 'input')
  }

  function isSelect(node: Element): node is HTMLSelectElement {
    return hasTag(node, 'select')
  }

  function isTextArea(node: Element): node is HTMLTextAreaElement {
    return hasTag(node, 'textarea')
  }

  function isButton(node: Element): node is HTMLButtonElement {
    return hasTag(node, 'button')
  }

  function isFieldSet(node: Element): node is HTMLFieldSetElement {
    return hasTag(node, 'fieldset')
  }

  function isOption(node: Element): node is HTMLOptionElement {
    return hasTag(node, 'option')
  }

  function isImage(node: Element): node is HTMLImageElement {
    return hasTag(node, 'img')
  }

  function isPasswordInput(node: Element): node is HTMLInputElement {
    return isInput(node) && node.type === 'password'
  }

  function isSecretKey(key: string): boolean {
    if (SECRET_SUBSTRING.test(key)) return true
    const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[^A-Za-z0-9]+/)
    return words.some(word => SECRET_WORDS.has(word.toLowerCase()))
  }

  function frameDocumentOf(host: Element): Document | null {
    try {
      const frameDocument: unknown = Reflect.get(host, 'contentDocument')
      return isDocument(frameDocument) ? frameDocument : null
    } catch {
      return null
    }
  }

  function rootsIn(start: ParentNode): ParentNode[] {
    const roots: ParentNode[] = [start]
    for (const host of Array.from(start.querySelectorAll('*'))) {
      const inner = host.shadowRoot ?? frameDocumentOf(host)
      if (inner) roots.push(...rootsIn(inner))
    }
    return roots
  }

  const roots = rootsIn(document)
  const el = roots.map(root => root.querySelector(`[${ATTR}="${marker}"]`)).find(found => found !== null) ?? null
  if (!el) return null

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
    roots.flatMap(root => Array.from(root.querySelectorAll('input')).filter(isPasswordInput).map(input => input.value)).filter(v => v !== ''),
  )

  function tagOf(value: object): string {
    try {
      return Object.prototype.toString.call(value)
    } catch {
      return ''
    }
  }

  function dateText(value: object): string {
    try {
      return Number.isNaN(Date.prototype.getTime.call(value)) ? '[Invalid Date]' : Date.prototype.toISOString.call(value)
    } catch {
      return '[Date]'
    }
  }

  function serialize(value: unknown, depth: number, hideKeylessStrings = false): unknown {
    try {
      return serializeValue(value, depth, hideKeylessStrings)
    } catch {
      return '[unreadable]'
    }
  }

  function serializeValue(value: unknown, depth: number, hideKeylessStrings: boolean): unknown {
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
    if (isElement(value)) return `<${value.tagName.toLowerCase()}>`
    if (!isRecord(value)) return String(value)
    const tag = tagOf(value)
    if (tag === '[object Date]') return dateText(value)
    if (tag === '[object Map]') return `[Map(${String(Reflect.get(value, 'size'))})]`
    if (tag === '[object Set]') return `[Set(${String(Reflect.get(value, 'size'))})]`
    if (tag === '[object Promise]') return '[Promise]'
    if ('$$typeof' in value) return `<${typeName(value.type)} />`
    if (depth >= 2) return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]'
    if (Array.isArray(value)) {
      const items = value.slice(0, 5).map(v => serialize(v, depth + 1, hideKeylessStrings))
      if (value.length > 5) items.push(`...(+${value.length - 5} more)`)
      return items
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = isSecretKey(k) ? '[redacted]' : serialize(v, depth + 1)
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

  function selectorIn(node: Element, root: ParentNode): string {
    if (node.id && root.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) return `#${CSS.escape(node.id)}`
    const parts: string[] = []
    let cur: Element | null = node
    while (cur && cur !== document.documentElement && parts.length < 8) {
      let part = cur.tagName.toLowerCase()
      const hint = ['data-testid', 'data-slot', 'name', 'aria-label', 'role'].find(a => cur?.hasAttribute(a))
      if (hint) part += `[${hint}=${quote(cur.getAttribute(hint) ?? '')}]`
      const parent: Element | null = cur.parentElement
      const tag = cur.tagName
      const same = Array.from((parent ?? root).children).filter(c => c.tagName === tag)
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`
      parts.unshift(part)
      const selector = parts.join(' > ')
      if (root.querySelectorAll(selector).length === 1) return selector
      cur = parent
    }
    return parts.join(' > ')
  }

  function hostOf(root: Node): Element | null {
    if (isShadowRoot(root)) return root.host
    if (!isDocument(root)) return null
    const frame: unknown = root.defaultView?.frameElement
    return isElement(frame) ? frame : null
  }

  function selectorFor(node: Element): string {
    const segments: string[] = []
    for (let cur: Element | null = node; cur; ) {
      const root = cur.getRootNode()
      if (!isParentNode(root)) break
      segments.unshift(selectorIn(cur, root))
      cur = hostOf(root)
    }
    return segments.join(' >>> ')
  }

  function topBox(node: Element): { x: number; y: number; width: number; height: number } {
    const { x, y, width, height } = node.getBoundingClientRect()
    let left = x
    let top = y
    for (let doc = node.ownerDocument; doc !== document; ) {
      const frame = doc.defaultView?.frameElement
      if (!frame) break
      const bounds = frame.getBoundingClientRect()
      const style = frame.ownerDocument.defaultView?.getComputedStyle(frame)
      left += bounds.x + frame.clientLeft + (parseFloat(style?.paddingLeft ?? '') || 0)
      top += bounds.y + frame.clientTop + (parseFloat(style?.paddingTop ?? '') || 0)
      doc = frame.ownerDocument
    }
    return { x: left, y: top, width, height }
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

  function boxModelOf(node: Element): BoxModel {
    const computed = getComputedStyle(node)
    const sides = (property: (side: string) => string): Sides => {
      const width = (side: string) => parseFloat(computed.getPropertyValue(property(side))) || 0
      return [width('top'), width('right'), width('bottom'), width('left')]
    }
    return {
      margin: sides(side => `margin-${side}`),
      padding: sides(side => `padding-${side}`),
      border: sides(side => `border-${side}-width`),
    }
  }

  function selectedTextIn(node: Element): string | undefined {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !selection.getRangeAt(0).intersectsNode(node)) return undefined
    return selection.toString().trim().slice(0, SELECTION_LIMIT) || undefined
  }

  function attributes(node: Element): Record<string, string> {
    const out: Record<string, string> = {}
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith('data-annotate-dom-')) continue
      out[attr.name] = attr.value.length > 300 ? `${attr.value.slice(0, 300)}...` : attr.value
    }
    if (isInput(node)) {
      const secret = node.type === 'password'
      if (secret && node.hasAttribute('value')) out.value = '[redacted]'
      out['(value)'] = secret ? '[redacted]' : node.value
      if (node.type === 'checkbox' || node.type === 'radio') out['(checked)'] = String(node.checked)
    }
    if (isTextArea(node) || isSelect(node)) out['(value)'] = node.value
    if (isButton(node) || isInput(node) || isSelect(node) || isTextArea(node)) out['(disabled)'] = String(node.disabled)
    return out
  }

  function outerHtmlWithoutPasswords(node: Element): string {
    const fields = [node, ...Array.from(node.querySelectorAll('input'))].filter(isPasswordInput)
    if (fields.length === 0) return node.outerHTML
    const copy = node.cloneNode(true)
    if (!isElement(copy)) return node.outerHTML
    for (const field of [copy, ...Array.from(copy.querySelectorAll('input'))].filter(isPasswordInput)) field.removeAttribute('value')
    return copy.outerHTML
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
        value: isSecretKey(key) ? '[redacted]' : value,
      })),
    }
  }

  function isIterable(value: unknown): value is Iterable<unknown> {
    return isRecord(value) && typeof Reflect.get(value, Symbol.iterator) === 'function'
  }

  function isStyleRule(value: unknown): value is CSSStyleRule {
    return isRecord(value) && typeof value.selectorText === 'string' && isRecord(value.style)
  }

  function isStyleSheet(value: unknown): value is CSSStyleSheet {
    return isRecord(value) && 'cssRules' in value
  }

  function sheetsOf(root: ParentNode): CSSStyleSheet[] {
    return ['styleSheets', 'adoptedStyleSheets'].flatMap(key => {
      const list: unknown = Reflect.get(root, key)
      return isIterable(list) ? Array.from(list).filter(isStyleSheet) : []
    })
  }

  function styleRules(root: ParentNode): CSSStyleRule[] {
    const rules: CSSStyleRule[] = []
    const visit = (list: Iterable<unknown>) => {
      for (const rule of list) {
        if (isStyleRule(rule)) rules.push(rule)
        if (isRecord(rule) && isIterable(rule.cssRules)) visit(rule.cssRules)
      }
    }
    for (const sheet of sheetsOf(root)) {
      try {
        visit(sheet.cssRules)
      } catch {
        continue
      }
    }
    return rules
  }

  function declaredNames(style: CSSStyleDeclaration): string[] {
    return Array.from(style).filter(name => name.startsWith('--'))
  }

  function customProperties(): string[] {
    return Array.from(new Set(styleRules(document).flatMap(rule => declaredNames(rule.style))))
  }

  function matchesNode(node: Element, selector: string): boolean {
    try {
      return node.matches(selector)
    } catch {
      return false
    }
  }

  function referencedNames(cssText: string): string[] {
    return Array.from(cssText.matchAll(VAR_REFERENCE), match => match[1] ?? '')
  }

  function isDeclaration(value: unknown): value is CSSStyleDeclaration {
    return isRecord(value) && typeof value.cssText === 'string' && typeof value.getPropertyValue === 'function'
  }

  function inlineStyleOf(node: Element): CSSStyleDeclaration | null {
    const style: unknown = Reflect.get(node, 'style')
    return isDeclaration(style) ? style : null
  }

  function enclosingElement(node: Element): Element | null {
    if (node.parentElement) return node.parentElement
    const root = node.getRootNode()
    return isShadowRoot(root) ? root.host : null
  }

  function secretVariableValues(node: Element): string[] {
    const values = new Set<string>()
    for (let n: Element | null = node; n; n = enclosingElement(n)) {
      const style = (n.ownerDocument.defaultView ?? window).getComputedStyle(n)
      for (const name of declaredNames(style)) {
        const value = style.getPropertyValue(name).trim()
        if (value !== '' && isSecretKey(name)) values.add(value)
      }
    }
    return Array.from(values)
  }

  function holdsSecret(value: string, secrets: readonly string[]): boolean {
    return secrets.some(secret => secret.length >= MIN_CONTAINED_SECRET && value.includes(secret))
  }

  function cssVariables(node: Element): CssVariable[] {
    const root = node.getRootNode()
    const rules = isParentNode(root) ? styleRules(root) : []
    const scoped: Element[] = []
    for (let n: Element | null = node; n && n !== n.ownerDocument.documentElement; n = n.parentElement) scoped.push(n)

    const referenced = new Set([
      ...referencedNames(inlineStyleOf(node)?.cssText ?? ''),
      ...rules.filter(rule => matchesNode(node, rule.selectorText)).flatMap(rule => referencedNames(rule.style.cssText)),
    ])
    for (const name of referenced) {
      for (const rule of rules) for (const next of referencedNames(rule.style.getPropertyValue(name))) referenced.add(next)
    }

    const declared = new Set([
      ...scoped.flatMap(n => {
        const style = inlineStyleOf(n)
        return style ? declaredNames(style) : []
      }),
      ...rules.filter(rule => scoped.some(n => matchesNode(n, rule.selectorText))).flatMap(rule => declaredNames(rule.style)),
    ])

    const computed = (node.ownerDocument.defaultView ?? window).getComputedStyle(node)
    const secrets = secretVariableValues(node)
    const ordered = [...Array.from(referenced).sort(), ...Array.from(declared).filter(name => !referenced.has(name)).sort()]
    return ordered
      .map(name => ({ name, value: computed.getPropertyValue(name).trim() }))
      .filter(v => v.value !== '' && !v.name.startsWith(TAILWIND_INTERNAL_PREFIX))
      .map(v => (isSecretKey(v.name) || holdsSecret(v.value, secrets) ? { name: v.name, value: '[redacted]' } : v))
      .slice(0, MAX_CSS_VARIABLES)
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
    const referenced = ids.map(id => normalized(node.ownerDocument.getElementById(id)?.textContent ?? '')).join(' ').trim()
    if (referenced) return referenced
    if (!(isInput(node) || isSelect(node) || isTextArea(node))) return ''
    return normalized(Array.from(node.labels ?? []).map(l => l.textContent).join(' '))
  }

  function nameOf(node: Element): string {
    const label = labelOf(node)
    if (label) return label
    if (isInput(node) && ['button', 'submit', 'reset'].includes(node.type)) return normalized(node.value)
    if (isImage(node)) return normalized(node.alt)
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
    const field = isInput(node) || isSelect(node) || isTextArea(node) ? node : null
    const textField = isInput(node) || isTextArea(node) ? node : null
    const disabled = field?.disabled === true || ((isButton(node) || isFieldSet(node) || isOption(node)) && node.disabled)
    if (disabled || aria('aria-disabled') === 'true') states.push('disabled')
    if ((isInput(node) && node.checked) || aria('aria-checked') === 'true') states.push('checked')
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

  const rect = topBox(el)
  const html = outerHtmlWithoutPasswords(el).replace(new RegExp(` data-annotate-dom-(?:target|focused|hovered)="[^"]*"`, 'g'), '')
  const fiber = fiberOf(el)
  const selectedText = selectedTextIn(el)

  return {
    selector: selectorFor(el),
    tag: el.tagName.toLowerCase(),
    html: html.length > HTML_LIMIT ? html.slice(0, HTML_LIMIT) : html,
    htmlTruncated: html.length > HTML_LIMIT,
    text: isHtml(el) ? el.innerText.trim().slice(0, 300) : '',
    box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    boxModel: boxModelOf(el),
    styles: pick(el, STYLE_KEYS),
    attributes: attributes(el),
    ancestors,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, userAgent: navigator.userAgent },
    react: fiber ? { elementStack: stackOf(fiber._debugStack), owners: owners(fiber._debugOwner) } : null,
    ...recorded(),
    queries: querySnapshots(fiber),
    interaction: interactionState(),
    tokens: designTokens(el),
    cssVariables: cssVariables(el),
    locator: locatorFor(el),
    a11y: accessibility(el),
    ...(selectedText !== undefined && { selectedText }),
  }
}

export async function axeViolations(marker: string): Promise<AxeViolation[]> {
  function isDocumentNode(value: unknown): value is Document {
    return typeof value === 'object' && value !== null && Reflect.get(value, 'nodeType') === 9
  }
  function frameDocumentOf(host: Element): Document | null {
    try {
      const inner: unknown = Reflect.get(host, 'contentDocument')
      return isDocumentNode(inner) ? inner : null
    } catch {
      return null
    }
  }
  function findMarked(root: ParentNode): Element | null {
    const direct = root.querySelector(`[data-annotate-dom-target="${marker}"]`)
    if (direct) return direct
    for (const host of Array.from(root.querySelectorAll('*'))) {
      const inner = host.shadowRoot ?? frameDocumentOf(host)
      const found = inner && findMarked(inner)
      if (found) return found
    }
    return null
  }
  function axeFor(doc: Document): unknown {
    const view = doc.defaultView
    return Reflect.get(view && view !== window ? view : window, 'axe')
  }
  const el = findMarked(document)
  const axe = el && axeFor(el.ownerDocument)
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
