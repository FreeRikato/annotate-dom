import { copyText } from './lib/clipboard'
import { sendLabel, SETTINGS_KEY } from './lib/daemon'
import { FOCUSED_ATTR, HOVERED_ATTR, MARKER_ATTR, type Reply, type Request, type Responses } from './lib/messages'
import { withSelectedCallSites } from './lib/callsites'
import { pageKey } from './lib/page'
import { createResolver } from './lib/resolve'
import { callSiteFrame, nextBasePath } from './lib/stack'
import { DETAIL_LEVELS, emptyBatch, isDetailLevel, PROJECT_ROOT_NOT_FOUND, type Batch, type Box, type Pin } from './lib/types'

const GLOBAL_KEY = '__annotateDomToggle'
const DAEMON_POLL_MS = 2000

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
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

function locate(pin: Pin): Element | null {
  try {
    return document.querySelector(pin.inspection.selector)
  } catch {
    return null
  }
}

function shortFile(file: string): string {
  return file.split('/').slice(-2).join('/')
}

function start(): () => void {
  const host = document.createElement('annotate-dom-root')
  const shadow = host.attachShadow({ mode: 'open' })
  const style = h('style', { text: CSS_TEXT })
  const root = h('div', { className: 'root' })
  const hl = h('div', { className: 'hl' })
  const hlLabel = h('div', { className: 'hl-label' })
  hl.append(hlLabel)
  const markers = h('div')

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

  const toast = h('div', { className: 'toast' })
  const toastText = h('span')
  const undoBtn = h('button', { text: 'Undo' })
  toast.append(toastText, undoBtn)

  root.append(hl, markers, panel, editor, toast)
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
  let editing: Element | null = null
  let pinContext: { readonly focused: Element | null; readonly hovered: Element | null } = { focused: null, hovered: null }
  let pinSelection: Range | null = null
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
      const r = el.getBoundingClientRect()
      const m = h('div', { className: 'marker', text: String(numberOf(pin.id)) })
      m.style.left = `${Math.max(11, r.left)}px`
      m.style.top = `${Math.max(11, r.top)}px`
      markers.append(m)
    }
  }

  function showHighlight(el: Element | null) {
    if (!el) {
      hl.style.display = 'none'
      return
    }
    const r = el.getBoundingClientRect()
    Object.assign(hl.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    const id = el.id ? `#${el.id}` : ''
    const cls = el.classList.length ? `.${Array.from(el.classList).slice(0, 2).join('.')}` : ''
    hlLabel.textContent = `${el.tagName.toLowerCase()}${id}${cls}  ${Math.round(r.width)}x${Math.round(r.height)}`
  }

  function appElement(candidate: Element | null | undefined): Element | null {
    return candidate && candidate !== document.body && candidate !== document.documentElement && candidate !== host ? candidate : null
  }

  function openEditor(el: Element) {
    editing = el
    pinContext = {
      focused: appElement(document.activeElement),
      hovered: appElement(Array.from(document.querySelectorAll(':hover')).filter(node => node !== host).at(-1)),
    }
    const selection = getSelection()
    pinSelection = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null
    showHighlight(el)
    const r = el.getBoundingClientRect()
    const left = Math.min(Math.max(8, r.left), innerWidth - 316)
    const below = r.bottom + 8
    const top = below + 130 < innerHeight ? below : Math.max(8, r.top - 138)
    Object.assign(editor.style, { display: 'block', left: `${left}px`, top: `${top}px` })
    textarea.value = ''
    textarea.focus()
  }

  function restoreSelection(range: Range | null) {
    const selection = getSelection()
    if (!range || !selection) return
    selection.removeAllRanges()
    selection.addRange(range)
  }

  function closeEditor() {
    editing = null
    editor.style.display = 'none'
    showHighlight(null)
  }

  async function savePin(el: Element, note: string) {
    busy = true
    renderList()
    const id = crypto.randomUUID()
    try {
      restoreSelection(pinSelection)
      el.setAttribute(MARKER_ATTR, id)
      const { focused, hovered } = pinContext
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
      const [elementSite, ...ownerSites] = await resolver.resolveAll([
        callSiteFrame(inspection.react?.elementStack ?? null),
        ...(inspection.react?.owners ?? []).map(o => callSiteFrame(o.stack)),
      ])
      const selected = withSelectedCallSites(inspection, ownerSites)
      inspection = selected.inspection

      host.style.visibility = 'hidden'
      await nextFrame()
      await nextFrame()
      const rect = boxOf(el)
      const rects: Record<string, Box> = { [id]: rect }
      for (const pin of batch.pins) {
        if (pin.path !== pageKey(location)) continue
        const other = locate(pin)
        if (other) rects[pin.id] = boxOf(other)
      }
      let shot
      try {
        shot = await call({ kind: 'capture', rect, viewportWidth: innerWidth })
      } finally {
        host.style.visibility = ''
      }
      const pin: Pin = {
        id,
        path: pageKey(location),
        url: location.href,
        note,
        createdAt: Date.now(),
        inspection,
        elementSite: elementSite ?? null,
        callSites: selected.callSites,
        crop: shot.crop,
      }
      batch = await call({ kind: 'add-pin', pin, viewport: shot.viewport, dpr: shot.dpr, rects })
    } catch (err: unknown) {
      setToast(`Could not save: ${err instanceof Error ? err.message : String(err)}`, false)
    } finally {
      busy = false
      renderList()
    }
  }

  function fromPage(event: Event): Element | null {
    if (event.composedPath().includes(host)) return null
    const first = event.composedPath()[0]
    return first instanceof Element ? first : null
  }

  function onMove(event: MouseEvent) {
    if (!visible || !picking || editing) return
    target = fromPage(event)
    showHighlight(target)
  }

  function swallow(event: Event) {
    if (!visible || !picking || !fromPage(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function onClick(event: MouseEvent) {
    if (!visible || !picking) return
    const el = fromPage(event)
    if (!el) return
    event.preventDefault()
    event.stopImmediatePropagation()
    openEditor(el)
  }

  function onKey(event: KeyboardEvent) {
    if (!visible || event.key !== 'Escape') return
    if (editing) closeEditor()
    else if (picking) {
      picking = false
      showHighlight(null)
      renderList()
    } else return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function submit() {
    const el = editing
    const note = textarea.value.trim()
    if (!el || !note) return
    closeEditor()
    void savePin(el, note)
  }

  textarea.addEventListener('keydown', event => {
    event.stopPropagation()
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeEditor()
    }
  })
  saveBtn.addEventListener('click', submit)
  cancelBtn.addEventListener('click', closeEditor)
  pickBtn.addEventListener('click', () => {
    picking = !picking
    if (!picking) closeEditor()
    renderList()
  })
  closeBtn.addEventListener('click', () => setVisible(false))
  async function sendToDaemon() {
    busy = true
    renderList()
    try {
      const { count, folder, prompt } = await call({ kind: 'send', origin: location.origin })
      batch = emptyBatch
      const delivered = await copyText(prompt)
      const sent = `Sent ${count} annotation${count === 1 ? '' : 's'} to .annotations/${folder}/`
      if (delivered === 'clipboard') {
        fallback.style.display = 'none'
        setToast(sent, false)
      } else {
        fallbackText.value = prompt
        fallback.style.display = 'block'
        fallbackText.select()
        setToast(`${sent}; clipboard blocked, prompt is in the panel.`, false)
      }
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
      if ((await copyText(markdown)) === 'clipboard') {
        fallback.style.display = 'none'
        setToast(`Copied ${count} annotation${count === 1 ? '' : 's'} to the clipboard.`, true)
      } else {
        fallbackText.value = markdown
        fallback.style.display = 'block'
        fallbackText.select()
        setToast('Clipboard blocked; markdown is in the panel.', true)
      }
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

  const opts = { capture: true }
  window.addEventListener('mousemove', onMove, opts)
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick']) {
    window.addEventListener(type, swallow, opts)
  }
  window.addEventListener('click', onClick, opts)
  window.addEventListener('keydown', onKey, opts)

  function tick() {
    if (!host.isConnected) document.documentElement.append(host)
    if (visible) {
      if (pageKey(location) !== lastPath) {
        lastPath = pageKey(location)
        renderList()
      }
      renderMarkers()
      if (editing) showHighlight(editing)
      else if (picking && target) showHighlight(target)
    }
    requestAnimationFrame(tick)
  }

  function setVisible(next: boolean) {
    visible = next
    picking = next
    host.style.display = next ? '' : 'none'
    if (!next) closeEditor()
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
    const level = typeof settings === 'object' && settings !== null && 'level' in settings ? settings.level : undefined
    if (isDetailLevel(level)) levelSelect.value = level
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
