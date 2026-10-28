// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { pickTarget } from './pick'

const viewport = { width: 1000, height: 800 }

function box(style: string, size: { width: number; height: number } = { width: 100, height: 40 }): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('style', style)
  el.getBoundingClientRect = () => new DOMRect(0, 0, size.width, size.height)
  document.body.append(el)
  return el
}

function pick(candidates: readonly Element[], overlayHost: Element | null = null): Element | null {
  return pickTarget({ candidates, viewport, overlayHost })
}

describe('pickTarget', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  it('returns the only visible candidate', () => {
    const button = box('')
    expect(pick([button])).toBe(button)
  })

  it('skips visibility hidden', () => {
    const hidden = box('visibility: hidden')
    const real = box('', { width: 300, height: 300 })
    expect(pick([hidden, real])).toBe(real)
  })

  it('skips display none', () => {
    const none = box('display: none')
    const real = box('', { width: 300, height: 300 })
    expect(pick([none, real])).toBe(real)
  })

  it('skips zero-size elements', () => {
    const flat = box('', { width: 0, height: 40 })
    const empty = box('', { width: 40, height: 0 })
    const real = box('', { width: 300, height: 300 })
    expect(pick([flat, empty, real])).toBe(real)
  })

  it('skips opacity under 0.1 and keeps 0.1', () => {
    const faint = box('opacity: 0.05')
    const dim = box('opacity: 0.1', { width: 300, height: 300 })
    expect(pick([faint, dim])).toBe(dim)
  })

  it('skips pointer-events none', () => {
    const through = box('pointer-events: none')
    const real = box('', { width: 300, height: 300 })
    expect(pick([through, real])).toBe(real)
  })

  it('skips a transparent layer as large as the viewport', () => {
    const backdrop = box('position: fixed', viewport)
    const bigger = box('position: fixed', { width: 1200, height: 900 })
    const button = box('')
    expect(pick([backdrop, bigger, button])).toBe(button)
  })

  it('treats a layer exactly as large as the viewport as covering it', () => {
    expect(pick([box('', viewport)])).toBeNull()
    expect(pick([box('', { width: 1000, height: 900 })])).toBeNull()
    expect(pick([box('', { width: 1100, height: 800 })])).toBeNull()
    expect(pick([box('', { width: 999, height: 800 })])).not.toBeNull()
    expect(pick([box('', { width: 1000, height: 799 })])).not.toBeNull()
  })

  it('keeps a viewport-sized layer that has a background colour', () => {
    const panel = box('background-color: rgb(255, 255, 255)', viewport)
    expect(pick([panel])).toBe(panel)
  })

  it('keeps a viewport-sized layer that has a background image', () => {
    const hero = box('background-image: url(a.png)', viewport)
    expect(pick([hero])).toBe(hero)
  })

  it('skips the overlay host', () => {
    const overlayHost = box('')
    const page = box('', { width: 300, height: 300 })
    expect(pick([overlayHost, page], overlayHost)).toBe(page)
  })

  it('returns the first remaining candidate in hit-test order', () => {
    const wrapper = box('', { width: 600, height: 400 })
    const button = box('', { width: 80, height: 30 })
    const row = box('', { width: 500, height: 50 })
    expect(pick([button, row, wrapper])).toBe(button)
    expect(pick([row, button, wrapper])).toBe(row)
  })

  it('returns an opaque dialog over a smaller element hidden behind it', () => {
    const dialog = box('background-color: rgb(255, 255, 255)', { width: 400, height: 300 })
    const icon = box('', { width: 16, height: 16 })
    const page = box('', { width: 900, height: 700 })
    expect(pick([dialog, icon, page])).toBe(dialog)
  })

  it('returns null when nothing is left', () => {
    expect(pick([box('display: none'), box('pointer-events: none')])).toBeNull()
    expect(pick([])).toBeNull()
  })
})
