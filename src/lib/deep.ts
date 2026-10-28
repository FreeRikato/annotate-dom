export function resolveDeep(selector: string): Element | null {
  const segments = selector.split(' >>> ')
  let root: ParentNode | null = document
  try {
    for (const segment of segments.slice(0, -1)) {
      const host: Element | null = root.querySelector(segment)
      root = host && (host.shadowRoot ?? Reflect.get(host, 'contentDocument'))
      if (!root) return null
    }
    return root.querySelector(segments[segments.length - 1] ?? '')
  } catch {
    return null
  }
}
