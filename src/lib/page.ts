export function pageKey({ pathname, hash }: Pick<Location, 'pathname' | 'hash'>): string {
  return hash.startsWith('#/') || hash.startsWith('#!/') ? `${pathname}${hash.split('?')[0]}` : pathname
}
