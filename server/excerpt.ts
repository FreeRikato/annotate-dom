import { readFile } from 'node:fs/promises'
import { extname, relative, sep } from 'node:path'
import type { Excerpt } from '../src/lib/markdown'
import type { SourceLoc } from '../src/lib/types'

const WINDOW = 5
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro'])

function isProjectSource(root: string, file: string): boolean {
  const inside = relative(root, file)
  if (inside === '' || inside.startsWith('..') || !SOURCE_EXTENSIONS.has(extname(inside))) return false
  return !inside.split(sep).some(segment => segment === 'node_modules' || segment.startsWith('.'))
}

async function readLines(file: string): Promise<readonly string[] | null> {
  const text = await readFile(file, 'utf8').catch(() => null)
  return text === null ? null : text.replace(/\n$/, '').split('\n')
}

export async function readExcerpts({ root, sites }: {
  readonly root: string
  readonly sites: readonly (SourceLoc | null)[]
}): Promise<Excerpt[]> {
  const wanted = new Map<string, SourceLoc>()
  for (const site of sites) {
    if (site && isProjectSource(root, site.file)) wanted.set(`${site.file}:${site.line}`, site)
  }
  const files = new Map<string, Promise<readonly string[] | null>>()
  const excerpts = await Promise.all([...wanted.values()].map(async ({ file, line }) => {
    const cached = files.get(file) ?? readLines(file)
    files.set(file, cached)
    const all = await cached
    if (!all || line < 1 || line > all.length) return null
    const startLine = Math.max(1, line - WINDOW)
    return { file, line, startLine, code: all.slice(startLine - 1, line + WINDOW).join('\n') }
  }))
  return excerpts.filter((excerpt): excerpt is Excerpt => excerpt !== null)
}
