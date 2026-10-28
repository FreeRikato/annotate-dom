import type { Box } from './types'

const MIN_OPACITY = 0.1
export const DRAG_THRESHOLD_PX = 8
export const MAX_DRAG_SELECTION = 10

type PickInput = {
  readonly candidates: readonly Element[]
  readonly viewport: { readonly width: number; readonly height: number }
  readonly overlayHost: Element | null
}

function isTransparent(style: CSSStyleDeclaration): boolean {
  const colour = style.backgroundColor
  const clear = colour === '' || colour === 'transparent' || /^rgba\(.*,\s*0\)$/.test(colour)
  return clear && (style.backgroundImage === '' || style.backgroundImage === 'none')
}

function isRealTarget(el: Element, { viewport, overlayHost }: Omit<PickInput, 'candidates'>): boolean {
  if (el === overlayHost) return false
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false
  if (style.opacity !== '' && Number(style.opacity) < MIN_OPACITY) return false
  const { width, height } = el.getBoundingClientRect()
  if (width === 0 || height === 0) return false
  return !(width >= viewport.width && height >= viewport.height && isTransparent(style))
}

export function pickTarget({ candidates, ...rest }: PickInput): Element | null {
  return candidates.find(el => isRealTarget(el, rest)) ?? null
}

export type Point = { readonly x: number; readonly y: number }

export function dragRect(from: Point, to: Point): Box {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) }
}

export function isDrag(from: Point, to: Point): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_THRESHOLD_PX
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

export function selectInRect<T extends { readonly box: Box }>({ items, rect, accept }: {
  readonly items: readonly T[]
  readonly rect: Box
  readonly accept: (item: T) => boolean
}): T[] {
  const inside = items
    .filter(({ box }) => box.w * box.h > 0 && overlapArea(box, rect) * 2 >= box.w * box.h)
    .sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)
  const picked: T[] = []
  for (const item of inside) {
    if (picked.length === MAX_DRAG_SELECTION) break
    if (accept(item)) picked.push(item)
  }
  return picked
}
