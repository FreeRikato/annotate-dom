export function resolveDeep(selector: string): Element | null {
  function split(source: string): string[] {
    const parts: string[] = []
    let quote = ''
    let from = 0
    for (let i = 0; i < source.length; i++) {
      const ch = source.charAt(i)
      if (ch === '\\') i++
      else if (quote) quote = ch === quote ? '' : quote
      else if (ch === '"' || ch === "'") quote = ch
      else if (source.startsWith(' >>> ', i)) {
        parts.push(source.slice(from, i))
        i += 4
        from = i + 1
      }
    }
    parts.push(source.slice(from))
    return parts
  }
  function isDocumentNode(value: unknown): value is Document {
    return typeof value === 'object' && value !== null && Reflect.get(value, 'nodeType') === 9
  }
  function frameDocumentOf(host: Element): Document | null {
    const inner: unknown = Reflect.get(host, 'contentDocument')
    return isDocumentNode(inner) ? inner : null
  }
  const segments = split(selector)
  let root: ParentNode | null = document
  try {
    for (const segment of segments.slice(0, -1)) {
      const host: Element | null = root.querySelector(segment)
      root = host && (host.shadowRoot ?? frameDocumentOf(host))
      if (!root) return null
    }
    return root.querySelector(segments[segments.length - 1] ?? '')
  } catch {
    return null
  }
}

export function isDocument(node: unknown): node is Document {
  return typeof node === 'object' && node !== null && Reflect.get(node, 'nodeType') === 9
}

export function frameDocument(frame: Element): Document | null {
  try {
    const inner: unknown = Reflect.get(frame, 'contentDocument')
    return isDocument(inner) ? inner : null
  } catch {
    return null
  }
}

export function isSealedFrame(el: Element): boolean {
  return el.localName === 'iframe' && frameDocument(el) === null
}

export function framesIn(doc: Document): Element[] {
  return [...doc.querySelectorAll('iframe')].flatMap(frame => {
    const inner = frameDocument(frame)
    return inner ? [frame, ...framesIn(inner)] : [frame]
  })
}

function frameContentOffset(frame: Element): { x: number; y: number } {
  const bounds = frame.getBoundingClientRect()
  const style = frame.ownerDocument.defaultView?.getComputedStyle(frame)
  return {
    x: bounds.left + frame.clientLeft + (parseFloat(style?.paddingLeft ?? '') || 0),
    y: bounds.top + frame.clientTop + (parseFloat(style?.paddingTop ?? '') || 0),
  }
}

function frameOffset(doc: Document): { x: number; y: number } {
  let x = 0
  let y = 0
  for (let frame = doc.defaultView?.frameElement; frame; frame = frame.ownerDocument.defaultView?.frameElement) {
    const offset = frameContentOffset(frame)
    x += offset.x
    y += offset.y
  }
  return { x, y }
}

export function topRect(el: Element): DOMRect {
  const r = el.getBoundingClientRect()
  const offset = frameOffset(el.ownerDocument)
  return new DOMRect(r.x + offset.x, r.y + offset.y, r.width, r.height)
}

export function pagePoint(event: MouseEvent): { x: number; y: number } {
  const offset = frameOffset(event.view?.document ?? document)
  return { x: event.clientX + offset.x, y: event.clientY + offset.y }
}

function collect(root: Document | ShadowRoot, x: number, y: number, overlayHost: Element, into: Element[]): void {
  for (const el of root.elementsFromPoint(x, y)) {
    if (el.getRootNode() !== root) continue
    if (el.shadowRoot && el !== overlayHost) collect(el.shadowRoot, x, y, overlayHost, into)
    const inner = el.localName === 'iframe' ? frameDocument(el) : null
    if (inner) {
      const offset = frameContentOffset(el)
      collect(inner, x - offset.x, y - offset.y, overlayHost, into)
    }
    into.push(el)
  }
}

export function deepCandidates(doc: Document, x: number, y: number, overlayHost: Element): Element[] {
  const candidates: Element[] = []
  collect(doc, x, y, overlayHost, candidates)
  return candidates
}
