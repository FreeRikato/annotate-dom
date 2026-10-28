const FREEZE_CSS = '*, *::before, *::after { animation-play-state: paused !important; }'

type Scope = Document | ShadowRoot

interface FreezeArgs {
  readonly root: Document
  readonly overlayHost: Element
}

const DOCUMENT_NODE = 9
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

const holds = new WeakMap<object, number>()

function hold(item: object) {
  holds.set(item, (holds.get(item) ?? 0) + 1)
}

function letGo(item: object): boolean {
  const left = (holds.get(item) ?? 1) - 1
  if (left > 0) holds.set(item, left)
  else holds.delete(item)
  return left <= 0
}

function isDocument(node: unknown): node is Document {
  return typeof node === 'object' && node !== null && 'nodeType' in node && node.nodeType === DOCUMENT_NODE
}

function freezeSheet(doc: Document): Element {
  const head = doc.head
  const sheet = head ? doc.createElement('style') : doc.createElementNS(SVG_NAMESPACE, 'style')
  sheet.textContent = FREEZE_CSS
  ;(head ?? doc.documentElement).append(sheet)
  return sheet
}

function innerDocument(frame: Element): Document | null {
  try {
    const inner: unknown = Reflect.get(frame, 'contentDocument')
    return isDocument(inner) ? inner : null
  } catch {
    return null
  }
}

function scopesOf(root: Scope, overlayHost: Element): Scope[] {
  const scopes = [root]
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot && el !== overlayHost) scopes.push(...scopesOf(el.shadowRoot, overlayHost))
    const inner = el.localName === 'iframe' ? innerDocument(el) : null
    if (inner) scopes.push(...scopesOf(inner, overlayHost))
  }
  return scopes
}

export function freezePage({ root, overlayHost }: FreezeArgs): () => void {
  const paused: Animation[] = []
  const videos: HTMLVideoElement[] = []
  const sheets: Element[] = []
  for (const scope of scopesOf(root, overlayHost)) {
    try {
      for (const animation of scope.getAnimations()) {
        if (animation.playState === 'running') animation.pause()
        else if (!holds.has(animation)) continue
        hold(animation)
        paused.push(animation)
      }
      for (const el of scope.querySelectorAll('video')) {
        if (el.paused || el.ended) {
          if (!holds.has(el)) continue
        } else el.pause()
        hold(el)
        videos.push(el)
      }
      if (isDocument(scope)) sheets.push(freezeSheet(scope))
    } catch {
      continue
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    for (const sheet of sheets) sheet.remove()
    for (const animation of paused) if (letGo(animation)) animation.play()
    for (const el of videos) if (letGo(el)) void el.play().catch(() => undefined)
  }
}
