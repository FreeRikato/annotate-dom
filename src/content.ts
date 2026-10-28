import { copyText } from './lib/clipboard'
import { deepCandidates, frameDocument, framesIn, isSealedFrame, pagePoint, resolveDeep, topRect } from './lib/deep'
import { freezePage } from './lib/freeze'
import { parseSavedLevel, sendLabel, SETTINGS_KEY } from './lib/daemon'
import { FOCUSED_ATTR, HOVERED_ATTR, MARKER_ATTR, type Reply, type Request, type Responses } from './lib/messages'
import { withSelectedCallSites } from './lib/callsites'
import { pageKey } from './lib/page'
import { connectorBetween, placeCard } from './lib/place'
import { dragRect, isDrag, pickTarget, selectInRect, type Point } from './lib/pick'
import { createResolver } from './lib/resolve'
import { callSiteFrame, nextBasePath } from './lib/stack'
import { DETAIL_LEVELS, emptyBatch, unionBox, PROJECT_ROOT_NOT_FOUND, type Batch, type Box, type Inspection, type AlsoTarget, type Pin, type SourceLoc } from './lib/types'

const GLOBAL_KEY = '__annotateDomToggle'
const DAEMON_POLL_MS = 2000
const SEALED_FRAME_TOAST = 'Elements inside this frame cannot be picked.'

async function call<K extends Request['kind']>(req: Extract<Request, { kind: K }>): Promise<Responses[K]> {
  const reply: Reply<K> = await chrome.runtime.sendMessage(req)
  if (!reply.ok) throw new Error(reply.error)
  return reply.data
}

const CSS_TEXT = `
:host { all: initial; }
.root { position: fixed; inset: 0; pointer-events: none; font: 13px/1.4 system-ui, -apple-system, sans-serif; color: #f4f4f5; }
.hl { position: fixed; border: 2px solid #ff3b30; background: rgba(255,59,48,.08); border-radius: 2px; display: none; }
.hl-label { position: absolute; left: -2px; top: -22px; background: #ff3b30; color: #fff; padding: 1px 6px; font-size: 11px; border-radius: 3px; white-space: nowrap; }
.drag { position: fixed; border: 1px dashed #ff3b30; background: rgba(255,59,48,.06); display: none; }
.sel { position: fixed; border: 2px solid #ff3b30; background: rgba(255,59,48,.12); border-radius: 2px; }
.sel-num { position: absolute; left: -2px; top: -22px; background: #ff3b30; color: #fff; padding: 1px 6px; font-size: 11px; border-radius: 3px; }
.shield { position: fixed; pointer-events: auto; }
.marker { position: fixed; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; background: #ff3b30; color: #fff; font-weight: 700; font-size: 12px; display: grid; place-items: center; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
.panel { position: fixed; right: 16px; bottom: 16px; width: 320px; max-height: 60vh; display: flex; flex-direction: column; background: #18181b; border: 1px solid #3f3f46; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.4); pointer-events: auto; overflow: hidden; }
.head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #3f3f46; }
.title { font-weight: 600; flex: 1; }
button { font: inherit; color: inherit; background: #27272a; border: 1px solid #3f3f46; border-radius: 6px; padding: 3px 8px; cursor: pointer; }
select { font: inherit; color: inherit; background: #27272a; border: 1px solid #3f3f46; border-radius: 6px; padding: 3px 4px; }
button:hover { background: #3f3f46; }
button.on { background: #ff3b30; border-color: #ff3b30; color: #fff; }
button.primary { background: #f4f4f5; color: #18181b; border-color: #f4f4f5; }
button:disabled { opacity: .4; cursor: default; }
.list { overflow: auto; padding: 4px 0; }
.empty { padding: 10px; color: #a1a1aa; }
.group { padding: 6px 10px 2px; color: #a1a1aa; font-size: 11px; }
.item { display: flex; gap: 8px; align-items: flex-start; padding: 4px 10px; }
.num { flex: none; width: 18px; height: 18px; border-radius: 50%; background: #ff3b30; color: #fff; font-size: 11px; font-weight: 700; display: grid; place-items: center; }
.note { flex: 1; word-break: break-word; }
.src { display: block; color: #a1a1aa; font-size: 11px; }
.del { padding: 0 6px; }
.editor { position: fixed; width: 300px; background: #18181b; border: 1px solid #3f3f46; border-radius: 10px; padding: 8px; pointer-events: auto; box-shadow: 0 8px 30px rgba(0,0,0,.4); display: none; }
.editor textarea { box-sizing: border-box; width: 100%; min-height: 70px; resize: vertical; font: inherit; color: #f4f4f5; background: #09090b; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px; }
.editor .row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; align-items: center; }
.editor .hint { flex: 1; color: #a1a1aa; font-size: 11px; }
.link { position: fixed; left: 0; top: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; display: none; }
.link line { stroke: #ff3b30; stroke-width: 1.5; stroke-dasharray: 4 3; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #18181b; border: 1px solid #3f3f46; border-radius: 8px; padding: 8px 12px; display: none; gap: 10px; align-items: center; pointer-events: auto; }
.fallback { display: none; padding: 8px 10px; border-top: 1px solid #3f3f46; }
.fallback textarea { box-sizing: border-box; width: 100%; height: 120px; font: 11px ui-monospace, monospace; color: #f4f4f5; background: #09090b; border: 1px solid #3f3f46; border-radius: 6px; }
`

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: { className?: string; text?: string } = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (props.className) node.className = props.className
  if (props.text !== undefined) node.textContent = props.text
  return node
}

function boxOf(el: Element): Box {
  const r = topRect(el)
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

function locate(pin: Pin): Element | null {
  return resolveDeep(pin.inspection.selector)
}

function isMouse(event: Event): event is MouseEvent {
  return typeof Reflect.get(event, 'clientX') === 'number'
}

function shortFile(file: string): string {
  return file.split('/').slice(-2).join('/')
}

type PinContext = { readonly focused: Element | null; readonly hovered: Element | null }
type PinCapture = {
  readonly id: string
  readonly sites: Promise<{ inspection: Inspection; elementSite: SourceLoc | null; callSites: Pin['callSites']; also: AlsoTarget[] }>
  readonly shot: Responses['capture']
  readonly rects: Record<string, Box>
}
type EditorSession = { readonly token: { cancelled: boolean }; readonly release: () => void; readonly ready: Promise<PinCapture | null> }

function start(): () => void {
  const host = document.createElement('annotate-dom-root')
  const shadow = host.attachShadow({ mode: 'open' })
  const style = h('style', { text: CSS_TEXT })
  const root = h('div', { className: 'root' })
  const hl = h('div', { className: 'hl' })
  const hlLabel = h('div', { className: 'hl-label' })
  hl.append(hlLabel)
  const markers = h('div')
  const shieldLayer = h('div')

  const panel = h('div', { className: 'panel' })
  const head = h('div', { className: 'head' })
  const title = h('span', { className: 'title', text: 'annotate-dom' })
  const pickBtn = h('button', { text: 'Pick' })
  const levelSelect = h('select')
  levelSelect.title = 'Detail level'
  levelSelect.ariaLabel = 'Detail level'
  for (const level of DETAIL_LEVELS) levelSelect.append(new Option(level, level))
  levelSelect.value = 'standard'
  const copyBtn = h('button', { className: 'primary', text: 'Copy all' })
  const closeBtn = h('button', { text: 'Close' })
  head.append(title, pickBtn, levelSelect, copyBtn, closeBtn)
  const list = h('div', { className: 'list' })
  const fallback = h('div', { className: 'fallback' })
  const fallbackText = h('textarea')
  fallback.append(h('div', { className: 'group', text: 'Clipboard blocked. Copy this manually:' }), fallbackText)
  panel.append(head, list, fallback)

  const editor = h('div', { className: 'editor' })
  const textarea = h('textarea')
  textarea.placeholder = 'What should change here?'
  const editorRow = h('div', { className: 'row' })
  const saveBtn = h('button', { className: 'primary', text: 'Save' })
  const cancelBtn = h('button', { text: 'Cancel' })
  editorRow.append(h('span', { className: 'hint', text: 'Enter saves, Shift+Enter new line' }), cancelBtn, saveBtn)
  editor.append(textarea, editorRow)

  const linkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  linkSvg.setAttribute('class', 'link')
  const linkLine = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  linkSvg.append(linkLine)

  const toast = h('div', { className: 'toast' })
  const toastText = h('span')
  const undoBtn = h('button', { text: 'Undo' })
  toast.append(toastText, undoBtn)

  const dragBox = h('div', { className: 'drag' })
  const selection = h('div')

  root.append(hl, dragBox, selection, markers, shieldLayer, panel, linkSvg, editor, toast)
  shadow.append(style, root)
  document.documentElement.append(host)

  const resolver = createResolver({
    pageOrigin: location.origin,
    fetcher: (url, init) => fetch(url, init),
    basePath: nextBasePath([...document.scripts].map(s => s.src), location.origin),
  })
  let batch: Batch = emptyBatch
  let visible = true
  let picking = true
  let busy = false
  let connected = false
  let target: Element | null = null
  let chain: Element[] = []
  let chainIndex = 0
  let walking = false
  let editing: Element | null = null
  let pending: Element[] = []
  let dragFrom: Point | null = null
  let dragging = false
  let swallowClick = false
  let session: EditorSession | null = null
  const frozen = new Set<() => void>()
  const shields = new Map<Element, HTMLElement>()
  const watched = new WeakSet<Document>()
  let warned: Element | null = null
  let lastPath = pageKey(location)
  let toastTimer = 0

  function setToast(text: string, withUndo: boolean) {
    toastText.textContent = text
    undoBtn.style.display = withUndo ? '' : 'none'
    toast.style.display = 'flex'
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => (toast.style.display = 'none'), withUndo ? 8000 : 4000)
  }

  function renderList() {
    list.replaceChildren()
    title.textContent = `annotate-dom (${batch.pins.length})`
    pickBtn.classList.toggle('on', picking)
    copyBtn.textContent = sendLabel(connected)
    copyBtn.disabled = busy || batch.pins.length === 0
    if (!batch.pins.length) {
      list.append(h('div', { className: 'empty', text: picking ? 'Click an element to annotate it. Esc stops picking.' : 'No annotations yet. Press Pick.' }))
      return
    }
    let n = 0
    for (const path of new Set(batch.pins.map(p => p.path))) {
      list.append(h('div', { className: 'group', text: path === pageKey(location) ? `${path} (this page)` : path }))
      for (const pin of batch.pins.filter(p => p.path === path)) {
        n += 1
        const item = h('div', { className: 'item' })
        const note = h('div', { className: 'note', text: pin.note })
        const where = pin.elementSite ?? pin.callSites.find(c => c.loc)?.loc ?? null
        note.append(h('span', { className: 'src', text: where ? `${shortFile(where.file)}:${where.line}` : pin.inspection.selector }))
        const del = h('button', { className: 'del', text: '×' })
        del.title = 'Delete'
        del.addEventListener('click', async () => {
          batch = await call({ kind: 'delete-pin', id: pin.id })
          renderList()
        })
        item.append(h('div', { className: 'num', text: String(n) }), note, del)
        list.append(item)
      }
    }
  }

  function numberOf(id: string): number {
    const paths = [...new Set(batch.pins.map(p => p.path))]
    const ordered = paths.flatMap(path => batch.pins.filter(p => p.path === path))
    return ordered.findIndex(p => p.id === id) + 1
  }

  function renderMarkers() {
    markers.replaceChildren()
    for (const pin of batch.pins) {
      if (pin.path !== pageKey(location)) continue
      const el = locate(pin)
      if (!el) continue
      const r = topRect(el)
      const m = h('div', { className: 'marker', text: String(numberOf(pin.id)) })
      m.style.left = `${Math.max(11, r.left)}px`
      m.style.top = `${Math.max(11, r.top)}px`
      markers.append(m)
    }
  }

  function renderSelection() {
    selection.replaceChildren()
    pending.forEach((el, i) => {
      const r = topRect(el)
      const mark = h('div', { className: 'sel' })
      Object.assign(mark.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
      mark.append(h('div', { className: 'sel-num', text: String(i + 1) }))
      selection.append(mark)
    })
  }

  function showHighlight(el: Element | null, position = '') {
    if (!el) {
      hl.style.display = 'none'
      return
    }
    const r = topRect(el)
    Object.assign(hl.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    const id = el.id ? `#${el.id}` : ''
    const cls = el.classList.length ? `.${Array.from(el.classList).slice(0, 2).join('.')}` : ''
    hlLabel.textContent = `${el.tagName.toLowerCase()}${id}${cls}  ${Math.round(r.width)}x${Math.round(r.height)}${position}`
  }

  function pickPosition(): string {
    return walking ? `  ${chainIndex + 1}/${chain.length}` : ''
  }

  function ancestorsBelowBody(el: Element): Element[] {
    const chain: Element[] = []
    for (let node: Element | null = el; node && node !== node.ownerDocument.body && node !== node.ownerDocument.documentElement; node = node.parentElement) chain.push(node)
    return chain
  }

  function resetWalk() {
    chainIndex = 0
    walking = false
    if (chain[0]) target = chain[0]
  }

  function pointTo(el: Element | null) {
    if (el === chain[0]) return
    chain = el ? ancestorsBelowBody(el) : []
    resetWalk()
    target = el
  }

  function appElement(candidate: Element | null | undefined): Element | null {
    return candidate && candidate !== document.body && candidate !== document.documentElement && candidate !== host ? candidate : null
  }

  function readPinContext() {
    return {
      focused: appElement(document.activeElement),
      hovered: appElement(Array.from(document.querySelectorAll(':hover')).filter(node => node !== host).at(-1)),
    }
  }

  function freeze(): () => void {
    const release = freezePage({ root: document, overlayHost: host })
    const tracked = () => {
      frozen.delete(tracked)
      release()
    }
    frozen.add(tracked)
    return tracked
  }

  function layoutEditor() {
    if (!editing) return
    const target = unionBox([boxOf(editing), ...pending.slice(1).map(boxOf)])
    const panelRect = panel.getBoundingClientRect()
    const others = visible && panelRect.width > 0 ? [{ x: panelRect.x, y: panelRect.y, w: panelRect.width, h: panelRect.height }] : []
    const card = { w: editor.offsetWidth, h: editor.offsetHeight }
    const { x, y } = placeCard({ target, card, viewport: { w: innerWidth, h: innerHeight }, others })
    Object.assign(editor.style, { left: `${x}px`, top: `${y}px` })
    const line = connectorBetween({ x, y, ...card }, target)
    for (const [name, value] of Object.entries(line)) linkLine.setAttribute(name, String(value))
    linkSvg.style.display = 'block'
  }

  function placeEditor(el: Element) {
    showHighlight(el)
    editor.style.display = 'block'
    layoutEditor()
    textarea.value = ''
    textarea.focus()
  }

  async function capturePin([el, ...rest]: readonly [Element, ...Element[]], context: PinContext, token: { cancelled: boolean }): Promise<PinCapture | null> {
    const id = crypto.randomUUID()
    const inspection = await markAndInspect(el, id, context)
    if (token.cancelled) return null
    host.style.visibility = 'hidden'
    let shot
    let rect
    const rects: Record<string, Box> = {}
    try {
      await nextFrame()
      await nextFrame()
      rect = unionBox([boxOf(el), ...rest.map(boxOf)])
      rects[id] = rect
      for (const pin of batch.pins) {
        if (pin.path !== pageKey(location)) continue
        const other = locate(pin)
        if (other) rects[pin.id] = boxOf(other)
      }
      shot = await call({ kind: 'capture', rect, viewportWidth: innerWidth })
    } finally {
      host.style.visibility = ''
    }
    if (token.cancelled) return null
    placeEditor(el)
    const sites = Promise.all([resolveSites(inspection), ...rest.map(alsoTarget)]).then(([main, ...also]) => ({ ...main, also }))
    return { id, sites, shot, rects }
  }

  function openEditor(members: readonly [Element, ...Element[]]) {
    const [el] = members
    cancelEditor()
    pending = members.length > 1 ? [...members] : []
    const token = { cancelled: false }
    const current: EditorSession = { token, release: freeze(), ready: capturePin(members, readPinContext(), token) }
    session = current
    editing = el
    showHighlight(el)
    current.ready.catch((err: unknown) => {
      if (session !== current) return
      cancelEditor()
      setToast(`Could not open the note: ${err instanceof Error ? err.message : String(err)}`, false)
    })
  }

  function closeEditor() {
    editing = null
    pending = []
    editor.style.display = 'none'
    linkSvg.style.display = 'none'
    showHighlight(null)
  }

  function cancelEditor() {
    if (session) {
      session.token.cancelled = true
      session.release()
      session = null
    }
    closeEditor()
  }

  async function markAndInspect(el: Element, id: string, { focused, hovered }: PinContext) {
    el.setAttribute(MARKER_ATTR, id)
    focused?.setAttribute(FOCUSED_ATTR, '')
    hovered?.setAttribute(HOVERED_ATTR, '')
    let inspection
    try {
      inspection = await call({ kind: 'inspect', marker: id })
    } finally {
      el.removeAttribute(MARKER_ATTR)
      focused?.removeAttribute(FOCUSED_ATTR)
      hovered?.removeAttribute(HOVERED_ATTR)
    }
    if (!inspection) throw new Error('Element is gone')
    return inspection
  }

  async function resolveSites(inspection: Inspection) {
    const [elementSite, ...ownerSites] = await resolver.resolveAll([
      callSiteFrame(inspection.react?.elementStack ?? null),
      ...(inspection.react?.owners ?? []).map(o => callSiteFrame(o.stack)),
    ])
    const selected = withSelectedCallSites(inspection, ownerSites)
    return { inspection: selected.inspection, elementSite: elementSite ?? null, callSites: selected.callSites }
  }

  async function alsoTarget(el: Element): Promise<AlsoTarget> {
    const { inspection, elementSite } = await inspectPinned(el, crypto.randomUUID(), { focused: null, hovered: null })
    return { selector: inspection.selector, locator: inspection.locator ?? null, elementSite, box: boxOf(el) }
  }

  async function inspectPinned(el: Element, id: string, context: PinContext) {
    return resolveSites(await markAndInspect(el, id, context))
  }

  async function savePin(current: EditorSession, note: string) {
    busy = true
    renderList()
    try {
      const captured = await current.ready
      if (!captured) return
      const { inspection, elementSite, callSites, also } = await captured.sites
      const pin: Pin = {
        id: captured.id,
        path: pageKey(location),
        url: location.href,
        note,
        createdAt: Date.now(),
        inspection,
        elementSite,
        callSites,
        crop: captured.shot.crop,
        ...(also.length ? { also } : {}),
      }
      batch = await call({ kind: 'add-pin', pin, viewport: captured.shot.viewport, dpr: captured.shot.dpr, rects: captured.rects })
    } catch (err: unknown) {
      setToast(`Could not save: ${err instanceof Error ? err.message : String(err)}`, false)
    } finally {
      current.release()
      busy = false
      renderList()
    }
  }

  async function deliver(text: string, toasts: { copied: string; blocked: string }, withUndo: boolean) {
    if ((await copyText(text)) === 'clipboard') {
      fallback.style.display = 'none'
      setToast(toasts.copied, withUndo)
    } else {
      fallbackText.value = text
      fallback.style.display = 'block'
      fallbackText.select()
      setToast(toasts.blocked, withUndo)
    }
  }

  async function quickGrab(el: Element) {
    resetWalk()
    showHighlight(null)
    try {
      const id = crypto.randomUUID()
      const { inspection, elementSite, callSites } = await inspectPinned(el, id, readPinContext())
      const pin: Pin = { id, path: pageKey(location), url: location.href, note: '', createdAt: Date.now(), inspection, elementSite, callSites, crop: '' }
      const { markdown } = await call({ kind: 'quick-grab', pin, origin: location.origin })
      await deliver(markdown, { copied: `Copied ${inspection.selector}`, blocked: 'Clipboard blocked; markdown is in the panel.' }, false)
    } catch (err: unknown) {
      setToast(`Could not copy: ${err instanceof Error ? err.message : String(err)}`, false)
    }
  }

  function fromPage(event: Event): Element | null {
    const path = event.composedPath()
    for (const [frame, shield] of shields) if (path.includes(shield)) return frame
    if (path.includes(host)) return null
    if (isMouse(event)) {
      const { x, y } = pagePoint(event)
      const candidates = deepCandidates(document, x, y, host)
      return pickTarget({ candidates, viewport: { width: innerWidth, height: innerHeight }, overlayHost: host })
    }
    const first = path[0]
    return first instanceof Element ? first : null
  }

  function onMove(event: MouseEvent) {
    if (!visible || !picking || editing || dragging) return
    pointTo(fromPage(event))
    showHighlight(target, pickPosition())
    const sealed = target && isSealedFrame(target) ? target : null
    if (sealed && sealed !== warned) setToast(SEALED_FRAME_TOAST, false)
    warned = sealed
  }

  function onWheel(event: WheelEvent) {
    if (!visible || !picking || editing || !event.altKey) return
    if (!fromPage(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    pointTo(fromPage(event))
    if (!chain.length || event.deltaY === 0) return
    walking = true
    chainIndex = Math.min(Math.max(chainIndex + (event.deltaY < 0 ? 1 : -1), 0), chain.length - 1)
    target = chain[chainIndex] ?? null
    showHighlight(target, pickPosition())
  }

  function onKeyUp(event: KeyboardEvent) {
    if (event.key !== 'Alt' || !walking) return
    resetWalk()
    showHighlight(target)
  }

  function swallow(event: Event) {
    if (!visible || !picking || !fromPage(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function onClick(event: MouseEvent) {
    if (!visible || !picking) return
    const hit = fromPage(event)
    if (!hit) return
    if (swallowClick) {
      swallowClick = false
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    const el = walking && target ? target : hit
    event.preventDefault()
    event.stopImmediatePropagation()
    if (isSealedFrame(el)) {
      setToast(SEALED_FRAME_TOAST, false)
      return
    }
    if (event.shiftKey) {
      void quickGrab(el)
      return
    }
    if ((event.metaKey || event.ctrlKey) && !editing) {
      toggleMember(el)
      return
    }
    if (pending.length && !editing) {
      setToast('Press Enter to write one note for the selected elements, or Escape to clear them.', false)
      return
    }
    resetWalk()
    openEditor([el])
  }

  function toggleMember(el: Element) {
    resetWalk()
    pending = pending.includes(el) ? pending.filter(member => member !== el) : [...pending, el]
  }

  function pickables(): { el: Element; box: Box }[] {
    return [...document.querySelectorAll('*')]
      .filter(el => el !== host && el !== document.body && el !== document.documentElement)
      .map(el => ({ el, box: boxOf(el) }))
  }

  function onDown(event: MouseEvent) {
    if (!visible || !picking || editing || event.button !== 0 || event.composedPath().includes(host)) return
    swallowClick = false
    dragFrom = pagePoint(event)
  }

  function onDragMove(event: MouseEvent) {
    if (!dragFrom) return
    if (!(event.buttons & 1)) {
      dragFrom = null
      return
    }
    const to = pagePoint(event)
    if (!dragging && !isDrag(dragFrom, to)) return
    dragging = true
    const r = dragRect(dragFrom, to)
    Object.assign(dragBox.style, { display: 'block', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
  }

  function onUp(event: MouseEvent) {
    const from = dragFrom
    dragFrom = null
    if (!from || !dragging) return
    dragging = false
    dragBox.style.display = 'none'
    swallowClick = true
    const view = { width: innerWidth, height: innerHeight }
    const chosen = selectInRect({
      items: pickables(),
      rect: dragRect(from, pagePoint(event)),
      accept: ({ el }) => pickTarget({ candidates: [el], viewport: view, overlayHost: host }) !== null,
    })
    pending = chosen.map(({ el }) => el)
    showHighlight(null)
  }

  function onKey(event: KeyboardEvent) {
    if (!visible) return
    const [first, ...rest] = pending
    if (event.key === 'Enter' && picking && !editing && first) {
      resetWalk()
      openEditor([first, ...rest])
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    if (event.key !== 'Escape') return
    if (editing) cancelEditor()
    else if (pending.length) pending = []
    else if (picking) {
      picking = false
      showHighlight(null)
      renderList()
    } else return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function submit() {
    const current = session
    const note = textarea.value.trim()
    if (!current || !editing || !note) return
    session = null
    closeEditor()
    void savePin(current, note)
  }

  textarea.addEventListener('keydown', event => {
    event.stopPropagation()
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancelEditor()
    }
  })
  saveBtn.addEventListener('click', submit)
  cancelBtn.addEventListener('click', cancelEditor)
  pickBtn.addEventListener('click', () => {
    picking = !picking
    if (!picking) cancelEditor()
    renderList()
  })
  closeBtn.addEventListener('click', () => setVisible(false))
  async function sendToDaemon() {
    busy = true
    renderList()
    try {
      const { count, folder, prompt } = await call({ kind: 'send', origin: location.origin })
      batch = emptyBatch
      const sent = `Sent ${count} annotation${count === 1 ? '' : 's'} to .annotations/${folder}/`
      await deliver(prompt, { copied: sent, blocked: `${sent}; clipboard blocked, prompt is in the panel.` }, false)
    } catch (err: unknown) {
      busy = false
      if (err instanceof Error && err.message === PROJECT_ROOT_NOT_FOUND) return copyAll()
      setToast(`Send failed: ${err instanceof Error ? err.message : String(err)}`, false)
    } finally {
      busy = false
      renderList()
    }
  }

  async function copyAll() {
    busy = true
    renderList()
    try {
      const { markdown, count } = await call({ kind: 'export', origin: location.origin })
      batch = emptyBatch
      await deliver(markdown, { copied: `Copied ${count} annotation${count === 1 ? '' : 's'} to the clipboard.`, blocked: 'Clipboard blocked; markdown is in the panel.' }, true)
    } catch (err: unknown) {
      setToast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, false)
    } finally {
      busy = false
      renderList()
    }
  }

  levelSelect.addEventListener('change', () => void chrome.storage.local.set({ [SETTINGS_KEY]: { level: levelSelect.value } }))
  copyBtn.addEventListener('click', () => (connected ? sendToDaemon() : copyAll()))
  undoBtn.addEventListener('click', async () => {
    batch = await call({ kind: 'undo' })
    toast.style.display = 'none'
    fallback.style.display = 'none'
    renderList()
  })

  function listenIn(win: Window) {
    const opts = { capture: true }
    win.addEventListener('pointerdown', onDown, opts)
    win.addEventListener('pointermove', onDragMove, opts)
    win.addEventListener('pointerup', onUp, opts)
    win.addEventListener('mousemove', onMove, opts)
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick']) {
      win.addEventListener(type, swallow, opts)
    }
    win.addEventListener('click', onClick, opts)
    win.addEventListener('keydown', onKey, opts)
    win.addEventListener('keyup', onKeyUp, opts)
    win.addEventListener('wheel', onWheel, { capture: true, passive: false })
  }
  listenIn(window)

  function syncFrames() {
    const sealed = new Set<Element>()
    for (const frame of picking && !editing ? framesIn(document) : []) {
      const inner = frameDocument(frame)
      if (!inner) sealed.add(frame)
      else if (inner.defaultView && !watched.has(inner)) {
        watched.add(inner)
        listenIn(inner.defaultView)
      }
    }
    for (const [frame, shield] of shields) {
      if (sealed.has(frame)) continue
      shield.remove()
      shields.delete(frame)
    }
    for (const frame of sealed) {
      const shield = shields.get(frame) ?? shieldLayer.appendChild(h('div', { className: 'shield' }))
      shields.set(frame, shield)
      const r = topRect(frame)
      Object.assign(shield.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) for (const release of [...frozen]) release()
  })

  function tick() {
    if (!host.isConnected) document.documentElement.append(host)
    if (visible) {
      if (pageKey(location) !== lastPath) {
        lastPath = pageKey(location)
        renderList()
      }
      renderMarkers()
      renderSelection()
      syncFrames()
      if (editing) {
        showHighlight(editing)
        if (editor.style.display === 'block') layoutEditor()
      }
      else if (picking && target) showHighlight(target, pickPosition())
    }
    requestAnimationFrame(tick)
  }

  function setVisible(next: boolean) {
    visible = next
    picking = next
    host.style.display = next ? '' : 'none'
    if (!next) cancelEditor()
    renderList()
  }

  function refreshDaemonStatus() {
    call({ kind: 'daemon-status' }).then(status => {
      if (status.connected === connected) return
      connected = status.connected
      renderList()
    }, () => undefined)
  }
  refreshDaemonStatus()
  window.setInterval(refreshDaemonStatus, DAEMON_POLL_MS)

  function showSavedLevel(settings: unknown) {
    const level = parseSavedLevel(settings)
    if (level) levelSelect.value = level
  }
  chrome.storage.local.get(SETTINGS_KEY).then((stored: Record<string, unknown>) => showSavedLevel(stored[SETTINGS_KEY]), () => undefined)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && SETTINGS_KEY in changes) showSavedLevel(changes[SETTINGS_KEY]?.newValue)
  })
  call({ kind: 'get-batch' }).then(b => {
    batch = b
    renderList()
  }, () => renderList())
  requestAnimationFrame(tick)

  return () => setVisible(!visible)
}

const existing: unknown = Reflect.get(window, GLOBAL_KEY)
if (typeof existing === 'function') existing()
else Reflect.set(window, GLOBAL_KEY, start())
