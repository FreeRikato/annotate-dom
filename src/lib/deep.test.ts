// @vitest-environment happy-dom
import { Window } from 'happy-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectElement } from '../inspect'
import { resolveDeep } from './deep'

const MARKER_ATTR = 'data-annotate-dom-target'
const runInPage: typeof inspectElement = new Function(`return ${inspectElement.toString()}`)()
const resolveInPage: typeof resolveDeep = new Function(`return ${resolveDeep.toString()}`)()

function element(parent: ParentNode, markup: string): Element {
  const holder = document.createElement('div')
  holder.innerHTML = markup
  const node = holder.firstElementChild
  if (!node) throw new Error('fixture missing')
  parent.append(node)
  return node
}

function shadowHost(parent: ParentNode, id: string, inner: string): { host: Element; root: ShadowRoot } {
  const host = element(parent, `<div id="${id}"></div>`)
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = inner
  return { host, root }
}

// happy-dom cannot load iframe pages, so a plain element stands in with the iframe's contentDocument and frameElement wiring
function frameWith(parent: ParentNode, id: string, bodyMarkup: string, offset: { x: number; y: number }): { frame: Element; doc: Document } {
  const frame = element(parent, `<div id="${id}"></div>`)
  const inner = new Window().document
  inner.body.innerHTML = bodyMarkup
  Object.defineProperty(frame, 'contentDocument', { value: inner })
  Object.defineProperty(inner.defaultView, 'frameElement', { value: frame })
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(offset.x, offset.y, 300, 200))
  return { frame, doc: inner as unknown as Document }
}

function box(node: Element, rect: { x: number; y: number; w: number; h: number }) {
  vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(new DOMRect(rect.x, rect.y, rect.w, rect.h))
}

function capture(node: Element) {
  node.setAttribute(MARKER_ATTR, 'deep1')
  const result = runInPage('deep1')
  node.removeAttribute(MARKER_ATTR)
  return result
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('deep selectors', () => {
  it('keeps the plain document selector as it was and resolves it back', () => {
    document.body.innerHTML = '<main><section><button data-testid="save">Save</button></section></main>'
    const button = document.querySelector('button')
    const result = button && capture(button)
    expect(result?.selector).toBe('button[data-testid="save"]')
    expect(resolveInPage('button[data-testid="save"]')).toBe(button)
  })

  it('joins the host selector and the inner selector for a shadow root', () => {
    const { root } = shadowHost(document.body, 'card-host', '<p>one</p><p class="x">two</p>')
    const inner = root.querySelector('.x')
    const result = inner && capture(inner)
    expect(result?.selector).toBe('#card-host >>> p:nth-of-type(2)')
    expect(resolveInPage(result?.selector ?? '')).toBe(inner)
  })

  it('joins the iframe selector and the inner selector for a same-origin frame', () => {
    const { doc } = frameWith(document.body, 'pane', '<ul><li>a</li><li id="b">b</li></ul>', { x: 0, y: 0 })
    const inner = doc.querySelector('#b')
    const result = inner && capture(inner)
    expect(result?.selector).toBe('#pane >>> #b')
    expect(resolveInPage('#pane >>> #b')).toBe(inner)
  })

  it('nests a shadow root inside an iframe', () => {
    const { doc } = frameWith(document.body, 'pane', '', { x: 0, y: 0 })
    const { root } = shadowHost(doc.body, 'widget', '<button>go</button>')
    const inner = root.querySelector('button')
    const result = inner && capture(inner)
    expect(result?.selector).toBe('#pane >>> #widget >>> button')
    expect(resolveInPage('#pane >>> #widget >>> button')).toBe(inner)
  })

  it('numbers siblings that sit directly under a shadow root', () => {
    const { root } = shadowHost(document.body, 'row', '<i></i><i></i>')
    const second = root.querySelectorAll('i')[1]
    const result = second && capture(second)
    expect(resolveInPage(result?.selector ?? '')).toBe(second)
  })

  it('ignores a contentDocument that is not a document', () => {
    const fake = element(document.body, '<div id="fake"><p>x</p></div>')
    Object.defineProperty(fake, 'contentDocument', { value: { nodeType: 1 } })
    expect(resolveInPage('#fake >>> p')).toBeNull()
    const { root } = shadowHost(document.body, 'after', '<b>q</b>')
    const inner = root.querySelector('b')
    expect(inner && capture(inner)?.selector).toBe('#after >>> b')
  })

  it('resolves to null when a segment is missing, closed or cross-origin', () => {
    const host = element(document.body, '<div id="closed"></div>')
    host.attachShadow({ mode: 'closed' })
    element(document.body, '<div id="far"></div>')
    expect(resolveInPage('#closed >>> p')).toBeNull()
    expect(resolveInPage('#far >>> p')).toBeNull()
    expect(resolveInPage('#nope >>> p')).toBeNull()
    expect(resolveInPage('p[')).toBeNull()
  })
})

describe('capture across documents', () => {
  it('reports the top-page box of an element in a shadow root without any offset', () => {
    const { root } = shadowHost(document.body, 'card-host', '<p class="x">hi</p>')
    const inner = root.querySelector('.x')
    if (!inner) throw new Error('fixture missing')
    box(inner, { x: 30, y: 40, w: 50, h: 20 })
    expect(capture(inner)?.box).toEqual({ x: 30, y: 40, w: 50, h: 20 })
  })

  it('adds the frame offset to the box of an element in an iframe', () => {
    const { doc } = frameWith(document.body, 'pane', '<p id="b">hi</p>', { x: 100, y: 200 })
    const inner = doc.querySelector('#b')
    if (!inner) throw new Error('fixture missing')
    box(inner, { x: 5, y: 6, w: 50, h: 20 })
    expect(capture(inner)?.box).toEqual({ x: 105, y: 206, w: 50, h: 20 })
  })

  it('adds every frame offset for a shadow root inside nested frames', () => {
    const outer = frameWith(document.body, 'outer', '', { x: 100, y: 200 })
    const innerFrame = frameWith(outer.doc.body, 'inner', '', { x: 10, y: 20 })
    const { root } = shadowHost(innerFrame.doc.body, 'widget', '<button>go</button>')
    const button = root.querySelector('button')
    if (!button) throw new Error('fixture missing')
    box(button, { x: 1, y: 2, w: 30, h: 10 })
    const result = capture(button)
    expect(result?.selector).toBe('#outer >>> #inner >>> #widget >>> button')
    expect(result?.box).toEqual({ x: 111, y: 222, w: 30, h: 10 })
  })

  it('finds a marked element in a document where the plain lookup finds nothing', () => {
    const { doc } = frameWith(document.body, 'pane', '<p id="b">hi</p>', { x: 0, y: 0 })
    expect(doc.querySelector('#b')).not.toBeNull()
    expect(document.querySelector(`[${MARKER_ATTR}]`)).toBeNull()
    const inner = doc.querySelector('#b')
    expect(inner && capture(inner)?.tag).toBe('p')
  })
})
