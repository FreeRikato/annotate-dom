// @vitest-environment happy-dom
import { Window } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axeViolations, inspectElement } from '../inspect'
import { isDocument, resolveDeep } from './deep'

const MARKER_ATTR = 'data-annotate-dom-target'
const runInPage: typeof inspectElement = new Function(`return ${inspectElement.toString()}`)()
const axeInPage: typeof axeViolations = new Function(`return ${axeViolations.toString()}`)()
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
  if (!isDocument(inner)) throw new Error('fixture is not a document')
  return { frame, doc: inner }
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

// happy-dom windows share one set of constructors, so a frame's elements would pass `instanceof` against the page's
// globals; standing in for the page's constructors with unrelated classes makes every frame element foreign to them
const DOM_CONSTRUCTORS = [
  'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement',
  'HTMLFieldSetElement', 'HTMLOptionElement', 'HTMLImageElement', 'CSSStyleRule',
]

beforeEach(() => {
  document.body.innerHTML = ''
  for (const name of DOM_CONSTRUCTORS) vi.stubGlobal(name, class {})
})

afterEach(() => {
  vi.unstubAllGlobals()
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
    Object.defineProperty(fake, 'contentDocument', { value: { nodeType: 1, querySelector: () => fake } })
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

describe('deep selectors with the separator inside a value', () => {
  it('resolves a plain selector that has the separator inside an attribute value', () => {
    const link = element(document.body, '<a data-x="a >>> b" id="t">x</a>')
    expect(resolveInPage('a[data-x="a >>> b"]')).toBe(link)
    expect(resolveInPage("a[data-x='a >>> b']")).toBe(link)
  })

  it('splits only at separators outside quotes and brackets', () => {
    const { host, root } = shadowHost(document.body, 'h', '<b>q</b>')
    host.setAttribute('data-x', 'a >>> b')
    expect(resolveInPage('div[data-x="a >>> b"] >>> b')).toBe(root.querySelector('b'))
  })

  it('captures a selector that resolves back when a hint attribute carries the separator', () => {
    const { root } = shadowHost(document.body, 'host2', '<button aria-label="Next >>> Back"></button><button aria-label="x"></button>')
    const inner = root.querySelector('button')
    const result = inner && capture(inner)
    expect(resolveInPage(result?.selector ?? '')).toBe(inner)
  })
})

describe('capture inside a document from another realm', () => {
  function pinTopButtonWith(note: string) {
    const button = element(document.body, '<button data-annotate-dom-target="top">Go</button>')
    Reflect.set(button, '__reactFiber$abc', {
      tag: 5,
      type: 'button',
      _debugOwner: { tag: 0, type: { displayName: 'Form' }, memoizedProps: { note }, memoizedState: null },
    })
    return runInPage('top')?.react?.owners[0]?.props
  }

  it('reads text, value, checked, disabled and the states of a control in a frame', () => {
    const { doc } = frameWith(document.body, 'pane', '<p id="p">hi there</p><input id="c" type="checkbox" aria-label="Agree" checked disabled><input id="t" value="ada">', { x: 0, y: 0 })
    const text = doc.querySelector('#p')
    const check = doc.querySelector('#c')
    const field = doc.querySelector('#t')
    expect(text && capture(text)?.text).toBe('hi there')
    const checked = check && capture(check)
    expect(checked?.attributes['(checked)']).toBe('true')
    expect(checked?.attributes['(disabled)']).toBe('true')
    expect(checked?.a11y?.states).toEqual(['disabled', 'checked'])
    expect(field && capture(field)?.attributes['(value)']).toBe('ada')
  })

  it('names a control in a frame from the aria-labelledby element in that frame', () => {
    const { doc } = frameWith(document.body, 'pane', '<span id="l">Close dialog</span><button id="x" aria-labelledby="l"></button>', { x: 0, y: 0 })
    const button = doc.querySelector('#x')
    expect(button && capture(button)?.a11y?.name).toBe('Close dialog')
  })

  it('names an element from a frame held in the props of an element on the page', () => {
    const { doc } = frameWith(document.body, 'pane', '<p id="p">hi</p>', { x: 0, y: 0 })
    const button = element(document.body, '<button data-annotate-dom-target="top">Go</button>')
    Reflect.set(button, '__reactFiber$abc', {
      tag: 5,
      type: 'button',
      _debugOwner: { tag: 0, type: { displayName: 'Form' }, memoizedProps: { target: doc.querySelector('#p') }, memoizedState: null },
    })
    expect(runInPage('top')?.react?.owners[0]?.props).toBe('{"target":"<p>"}')
  })

  it('redacts a password typed in a frame from the props of an element on the page', () => {
    const { doc } = frameWith(document.body, 'pane', '<input id="pw" type="password">', { x: 0, y: 0 })
    Reflect.set(doc.querySelector('#pw') ?? {}, 'value', 'hunter2-password')
    expect(pinTopButtonWith('hunter2-password')).toContain('[redacted]')
  })

  it('redacts a password typed in a shadow root from the props of an element on the page', () => {
    const { root } = shadowHost(document.body, 'vault', '<input type="password">')
    const input = root.querySelector('input')
    if (!input) throw new Error('fixture missing')
    input.value = 'hunter2-password'
    expect(pinTopButtonWith('hunter2-password')).not.toContain('hunter2-password')
  })

  it('redacts the value of a password input in a frame, in the attributes and in the html', () => {
    const { doc } = frameWith(document.body, 'pane', '<input id="pw" type="password" value="hunter2">', { x: 0, y: 0 })
    const input = doc.querySelector('#pw')
    const result = input && capture(input)
    expect(result?.attributes.value).toBe('[redacted]')
    expect(result?.html).not.toContain('hunter2')
  })

  it('runs axe on the marked element inside a frame', async () => {
    const { doc } = frameWith(document.body, 'pane', '<button id="b">Go</button>', { x: 0, y: 0 })
    const button = doc.querySelector('#b')
    if (!button) throw new Error('fixture missing')
    const run = vi.fn(async () => ({ violations: [] }))
    const view = button.ownerDocument.defaultView
    if (!view) throw new Error('fixture missing')
    Reflect.set(window, 'axe', { run: vi.fn(async () => ({ violations: [] })) })
    Reflect.set(view, 'axe', { run })
    button.setAttribute(MARKER_ATTR, 'axe1')
    await axeInPage('axe1')
    Reflect.deleteProperty(window, 'axe')
    expect(run).toHaveBeenCalledWith(button)
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
