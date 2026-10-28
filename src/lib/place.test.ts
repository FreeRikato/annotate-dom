import { describe, expect, it } from 'vitest'
import { connectorBetween, placeCard } from './place'
import type { Box } from './types'

const viewport = { w: 1000, h: 800 }
const card = { w: 300, h: 140 }

function place(target: Box, others: readonly Box[] = []): Box {
  const { x, y } = placeCard({ target, card, viewport, others })
  return { x, y, ...card }
}

function inside(b: Box): boolean {
  return b.x >= 8 && b.y >= 8 && b.x + b.w <= viewport.w - 8 && b.y + b.h <= viewport.h - 8
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

describe('placeCard', () => {
  it('puts the card to the right of a target in the middle', () => {
    expect(place({ x: 200, y: 300, w: 100, h: 40 })).toEqual({ x: 308, y: 300, ...card })
  })

  it('goes left when the right side has no room', () => {
    expect(place({ x: 800, y: 300, w: 100, h: 40 })).toEqual({ x: 492, y: 300, ...card })
  })

  it('goes below when neither side has room', () => {
    const target = { x: 20, y: 100, w: 960, h: 40 }
    expect(place(target)).toEqual({ x: 20, y: 148, ...card })
  })

  it('goes above when only above has room', () => {
    const target = { x: 20, y: 640, w: 960, h: 100 }
    expect(place(target)).toEqual({ x: 20, y: 492, ...card })
  })

  it('stays inside the viewport for a target at the left edge', () => {
    expect(inside(place({ x: 0, y: 300, w: 60, h: 40 }))).toBe(true)
  })

  it('stays inside the viewport for a target at the right edge', () => {
    const placed = place({ x: 940, y: 300, w: 60, h: 40 })
    expect(inside(placed)).toBe(true)
    expect(placed.x + placed.w).toBeLessThanOrEqual(940 - 8)
  })

  it('slides up for a target at the bottom edge', () => {
    const placed = place({ x: 200, y: 770, w: 100, h: 30 })
    expect(inside(placed)).toBe(true)
    expect(placed.x).toBe(308)
  })

  it('slides down for a target at the top edge', () => {
    const placed = place({ x: 200, y: 0, w: 100, h: 20 })
    expect(inside(placed)).toBe(true)
    expect(placed.y).toBe(8)
  })

  it('stays inside the viewport for a target in the top-left corner', () => {
    expect(inside(place({ x: 0, y: 0, w: 40, h: 20 }))).toBe(true)
  })

  it('stays inside the viewport for a target in the bottom-right corner', () => {
    expect(inside(place({ x: 960, y: 780, w: 40, h: 20 }))).toBe(true)
  })

  it('skips a side taken by another card', () => {
    const target = { x: 200, y: 300, w: 100, h: 40 }
    const other = { x: 308, y: 300, ...card }
    const placed = place(target, [other])
    expect(overlaps(placed, other)).toBe(false)
    expect(placed.y + placed.h).toBeLessThanOrEqual(292)
  })

  it('places two adjacent targets without overlapping cards', () => {
    const first = { x: 200, y: 300, w: 100, h: 40 }
    const second = { x: 310, y: 300, w: 100, h: 40 }
    const firstCard = place(first)
    const secondCard = place(second, [firstCard])
    expect(overlaps(firstCard, secondCard)).toBe(false)
    expect(inside(secondCard)).toBe(true)
  })

  it('falls back to the least overlap, inside the viewport, when every side is taken', () => {
    const target = { x: 400, y: 300, w: 100, h: 40 }
    const wall = { x: 0, y: 0, w: 1000, h: 800 }
    const placed = place(target, [wall])
    expect(inside(placed)).toBe(true)
  })

  it('prefers the candidate overlapping a smaller area when all overlap', () => {
    const target = { x: 400, y: 300, w: 100, h: 40 }
    const blockers: Box[] = [
      { x: 508, y: 0, w: 300, h: 800 },
      { x: 92, y: 0, w: 300, h: 800 },
      { x: 0, y: 348, w: 1000, h: 140 },
      { x: 400, y: 152, w: 300, h: 100 },
    ]
    const placed = place(target, blockers)
    expect(inside(placed)).toBe(true)
    expect(placed.y + placed.h).toBeLessThanOrEqual(292)
  })
})

describe('connectorBetween', () => {
  it('joins the card edge to the nearest point of a target on its left', () => {
    const line = connectorBetween({ x: 308, y: 300, ...card }, { x: 200, y: 310, w: 100, h: 40 })
    expect(line).toEqual({ x1: 308, y1: 330, x2: 300, y2: 330 })
  })

  it('joins from above when the card sits below the target', () => {
    const line = connectorBetween({ x: 20, y: 148, ...card }, { x: 100, y: 100, w: 40, h: 40 })
    expect(line.y1).toBe(148)
    expect(line.y2).toBe(140)
    expect(line.x1).toBe(line.x2)
  })
})
