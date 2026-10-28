const MIN_OPACITY = 0.1

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
