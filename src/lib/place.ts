import type { Box } from './types'

export const VIEWPORT_MARGIN = 8
const GAP = 8

export type Size = { readonly w: number; readonly h: number }
export type Line = { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }

type Corner = { readonly x: number; readonly y: number }

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high))
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function fitsInside(card: Box, viewport: Size): boolean {
  return card.x >= VIEWPORT_MARGIN && card.y >= VIEWPORT_MARGIN && card.x + card.w <= viewport.w - VIEWPORT_MARGIN && card.y + card.h <= viewport.h - VIEWPORT_MARGIN
}

export function placeCard({ target, card, viewport, others }: { target: Box; card: Size; viewport: Size; others: readonly Box[] }): Corner {
  const slideX = (x: number) => clamp(x, VIEWPORT_MARGIN, viewport.w - card.w - VIEWPORT_MARGIN)
  const slideY = (y: number) => clamp(y, VIEWPORT_MARGIN, viewport.h - card.h - VIEWPORT_MARGIN)
  const sides: Corner[] = [
    { x: target.x + target.w + GAP, y: slideY(target.y) },
    { x: target.x - GAP - card.w, y: slideY(target.y) },
    { x: slideX(target.x), y: target.y + target.h + GAP },
    { x: slideX(target.x), y: target.y - GAP - card.h },
  ]
  const boxed = (corner: Corner): Box => ({ ...corner, ...card })
  const free = sides.find(corner => fitsInside(boxed(corner), viewport) && others.every(other => overlapArea(boxed(corner), other) === 0))
  if (free) return free
  const squeezed = sides.map(corner => ({ x: slideX(corner.x), y: slideY(corner.y) }))
  const cost = (corner: Corner) => others.reduce((sum, other) => sum + overlapArea(boxed(corner), other), 0)
  return squeezed.reduce((best, corner) => (cost(corner) < cost(best) ? corner : best))
}

function facing(card: readonly [number, number], target: readonly [number, number]): readonly [number, number] {
  const low = Math.max(card[0], target[0])
  const high = Math.min(card[1], target[1])
  if (low <= high) return [(low + high) / 2, (low + high) / 2]
  return card[1] < target[0] ? [card[1], target[0]] : [card[0], target[1]]
}

export function connectorBetween(card: Box, target: Box): Line {
  const [x1, x2] = facing([card.x, card.x + card.w], [target.x, target.x + target.w])
  const [y1, y2] = facing([card.y, card.y + card.h], [target.y, target.y + target.h])
  return { x1, y1, x2, y2 }
}
