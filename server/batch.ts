import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { type ExportPage, toMarkdown } from '../src/lib/markdown'
import type { CallSite, Pin, SourceLoc } from '../src/lib/types'

export type WirePage = { readonly path: string; readonly url: string; readonly viewport: string | null }

export type WireBatch = {
  readonly origin: string
  readonly createdAt: number
  readonly pages: readonly WirePage[]
  readonly pins: readonly (Pin & { readonly n: number })[]
}

export type StoredRecapture = {
  readonly at: number
  readonly afterFile: string
  readonly styleDiff: readonly { readonly prop: string; readonly before: string; readonly after: string }[]
  readonly htmlChanged: boolean
}

export type Excerpt = { readonly file: string; readonly line: number; readonly startLine: number; readonly code: string }

export type StoredPin = Omit<Pin, 'crop'> & {
  readonly n: number
  readonly cropFile: string
  readonly excerpts: readonly Excerpt[]
  readonly status: 'open' | 'resolved'
  readonly summary: string | null
  readonly resolvedAt: number | null
  readonly recaptures: readonly StoredRecapture[]
}

export type StoredBatch = {
  readonly version: 1
  readonly folder: string
  readonly project: string
  readonly origin: string
  readonly createdAt: number
  readonly pages: readonly { readonly path: string; readonly url: string; readonly viewportFile: string | null }[]
  readonly pins: readonly StoredPin[]
}

export type WrittenBatch = { readonly folder: string; readonly prompt: string }

const ANNOTATIONS_DIR = '.annotations'

function slug(path: string): string {
  return path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'index'
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

async function claimFolder(annotations: string, base: string): Promise<string> {
  await mkdir(annotations, { recursive: true })
  for (let attempt = 1; ; attempt += 1) {
    const folder = attempt === 1 ? base : `${base}-${attempt}`
    try {
      await mkdir(join(annotations, folder))
      return folder
    } catch (err: unknown) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err
    }
  }
}

function decodeDataUrl(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
}

function absoluteLoc(root: string, loc: SourceLoc | null): SourceLoc | null {
  if (!loc || isAbsolute(loc.file)) return loc
  return { ...loc, file: join(root, loc.file) }
}

function absoluteCallSite(root: string, site: CallSite): CallSite {
  return { ...site, loc: absoluteLoc(root, site.loc) }
}

function storedPin(root: string, { crop: _crop, ...pin }: Pin & { readonly n: number }): StoredPin {
  return {
    ...pin,
    elementSite: absoluteLoc(root, pin.elementSite),
    callSites: pin.callSites.map(site => absoluteCallSite(root, site)),
    cropFile: `pin-${pin.n}.png`,
    excerpts: [],
    status: 'open',
    summary: null,
    resolvedAt: null,
    recaptures: [],
  }
}

export function renderStoredMarkdown(batch: StoredBatch): string {
  const pages: ExportPage[] = batch.pages.map(page => ({
    ...page,
    pins: batch.pins
      .filter(pin => pin.path === page.path)
      .map(pin => ({ pin: { ...pin, crop: '' }, cropFile: pin.cropFile })),
  }))
  return toMarkdown({ origin: batch.origin, createdAt: batch.createdAt, pages })
}

async function run(root: string, args: readonly string[]): Promise<string | null> {
  const proc = Bun.spawn(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout).text()
  return (await proc.exited) === 0 ? text.trim() : null
}

async function excludeAnnotations(root: string): Promise<void> {
  const relative = await run(root, ['rev-parse', '--git-path', 'info/exclude'])
  if (!relative) return
  const file = resolve(root, relative)
  const existing = await readFile(file, 'utf8').catch(() => '')
  if (existing.split('\n').includes(`${ANNOTATIONS_DIR}/`)) return
  await mkdir(resolve(file, '..'), { recursive: true })
  await appendFile(file, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${ANNOTATIONS_DIR}/\n`)
}

async function recordProject(home: string, root: string): Promise<void> {
  const file = join(home, 'projects.json')
  const known: string[] = JSON.parse(await readFile(file, 'utf8').catch(() => '[]'))
  if (known.includes(root)) return
  await mkdir(home, { recursive: true })
  await writeFile(file, JSON.stringify([...known, root], null, 2))
}

export async function writeBatch({ root, home, batch }: {
  readonly root: string
  readonly home: string
  readonly batch: WireBatch
}): Promise<WrittenBatch> {
  await recordProject(home, root)
  const firstPage = batch.pages[0]?.path ?? '/'
  const folder = await claimFolder(join(root, ANNOTATIONS_DIR), `${stamp(batch.createdAt)}-${slug(firstPage)}`)
  const dir = join(root, ANNOTATIONS_DIR, folder)
  const pages = batch.pages.map(page => ({
    path: page.path,
    url: page.url,
    viewportFile: page.viewport ? `viewport-${slug(page.path)}.png` : null,
  }))
  const stored: StoredBatch = {
    version: 1, folder, project: root, origin: batch.origin, createdAt: batch.createdAt,
    pages, pins: batch.pins.map(pin => storedPin(root, pin)),
  }
  await Promise.all([
    writeFile(join(dir, 'batch.json'), JSON.stringify(stored, null, 2)),
    writeFile(join(dir, 'batch.md'), renderStoredMarkdown(stored)),
    ...batch.pins.map(pin => writeFile(join(dir, `pin-${pin.n}.png`), decodeDataUrl(pin.crop))),
    ...batch.pages.flatMap((page, i) => {
      const file = pages[i]?.viewportFile
      return page.viewport && file ? [writeFile(join(dir, file), decodeDataUrl(page.viewport))] : []
    }),
  ])
  await excludeAnnotations(root)
  return { folder, prompt: `Fix the annotations in ${ANNOTATIONS_DIR}/${folder}/` }
}

