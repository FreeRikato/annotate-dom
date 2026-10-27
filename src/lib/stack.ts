export type Frame = { readonly fn: string; readonly file: string; readonly line: number; readonly column: number }

const REACT_INTERNAL = /^(exports\.jsxDEV|exports\.jsx|jsxDEV|fakeJSXCallSite|Object\.react_stack_bottom_frame|react_stack_bottom_frame)$/

export const SERVER_PREFIX = 'about://React/Server/'

export function parseFrames(stack: string): Frame[] {
  const frames: Frame[] = []
  for (const raw of stack.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('at ')) continue
    const body = line.slice(3)
    const paren = body.match(/^(.*?) \((.*):(\d+):(\d+)\)$/)
    if (paren) {
      frames.push({ fn: paren[1], file: paren[2], line: Number(paren[3]), column: Number(paren[4]) })
      continue
    }
    const bare = body.match(/^(.*):(\d+):(\d+)$/)
    if (bare) frames.push({ fn: '<anonymous>', file: bare[1], line: Number(bare[2]), column: Number(bare[3]) })
  }
  return frames
}

export function callSiteFrame(stack: string | null): Frame | null {
  if (!stack) return null
  return parseFrames(stack).find(f => !REACT_INTERNAL.test(f.fn) && !f.file.startsWith('<')) ?? null
}

export function isServerFrame(frame: Frame): boolean {
  return frame.file.startsWith(SERVER_PREFIX)
}

export function serverFileUrl(frame: Frame): string {
  return frame.file.slice(SERVER_PREFIX.length).replace(/\?\d+$/, '')
}

export function projectRootFromServerFile(fileUrl: string): string | null {
  const path = decodeURIComponent(fileUrl.replace(/^file:\/\//, ''))
  const i = path.indexOf('/.next/')
  return i === -1 ? null : path.slice(0, i)
}

export function normalizeSource({ source, pageOrigin }: { readonly source: string; readonly pageOrigin: string }): string {
  if (source.startsWith('file://')) return decodeURIComponent(source.slice('file://'.length))
  if (source.startsWith(pageOrigin + '/')) return decodeURIComponent(source.slice(pageOrigin.length + 1).split('?')[0])
  return source
}
