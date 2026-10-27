import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { SourceLoc } from '../src/lib/types'
import type { StoredBatch, StoredPin } from './batch'

export type PinStatus = StoredPin['status']

export type AnnotationSummary = {
  readonly id: string
  readonly project: string
  readonly note: string
  readonly path: string
  readonly elementSite: SourceLoc | null
  readonly status: PinStatus
}

export type AnnotationDetail = Omit<StoredPin, 'cropFile'> & {
  readonly id: string
  readonly project: string
  readonly cropFile: string
}

export type Located = {
  readonly batch: StoredBatch
  readonly pin: StoredPin
  readonly dir: string
  readonly root: string
}

type ReadBatch = { readonly batch: StoredBatch; readonly root: string; readonly folder: string }

export class AmbiguousAnnotationError extends Error {
  override readonly name = 'AmbiguousAnnotationError'
  constructor(id: string, projects: readonly string[]) {
    super(`annotation id ${id} exists in several projects (${projects.join(', ')}); pass project`)
  }
}

const ANNOTATIONS_DIR = '.annotations'

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

function isStoredBatch(value: unknown): value is StoredBatch {
  return typeof value === 'object' && value !== null && 'version' in value && value.version === 1
    && 'pins' in value && Array.isArray(value.pins)
}

export async function knownProjects(home: string): Promise<string[]> {
  const known = await readJson(join(home, 'projects.json'))
  return Array.isArray(known) ? known.filter((root): root is string => typeof root === 'string') : []
}

function rootsFor(known: readonly string[], project: string | undefined): string[] {
  if (project === undefined) return [...known]
  return known.filter(root => project === root || project.startsWith(root + sep))
}

async function readBatches(root: string): Promise<ReadBatch[]> {
  const folders = await readdir(join(root, ANNOTATIONS_DIR)).catch(() => [])
  const batches = await Promise.all(folders.map(async folder => ({
    batch: await readJson(join(root, ANNOTATIONS_DIR, folder, 'batch.json')),
    root,
    folder,
  })))
  return batches.flatMap(({ batch, root, folder }) => isStoredBatch(batch) ? [{ batch, root, folder }] : [])
}

export const annotationId = (folder: string, n: number): string => `${folder}#${n}`

const annotationDir = ({ root, folder }: Pick<ReadBatch, 'root' | 'folder'>): string => join(root, ANNOTATIONS_DIR, folder)

export async function listAnnotations({ home, project, status }: {
  readonly home: string
  readonly project?: string
  readonly status: PinStatus
}): Promise<AnnotationSummary[]> {
  const roots = rootsFor(await knownProjects(home), project)
  const batches = (await Promise.all(roots.map(readBatches))).flat().sort((a, b) => b.batch.createdAt - a.batch.createdAt)
  return batches.flatMap(({ batch, root, folder }) => batch.pins
    .filter(pin => pin.status === status)
    .map(pin => ({
      id: annotationId(folder, pin.n), project: root, note: pin.note, path: pin.path,
      elementSite: pin.elementSite, status: pin.status,
    })))
}

async function locate({ home, id, project }: {
  readonly home: string
  readonly id: string
  readonly project?: string
}): Promise<Located | null> {
  const roots = rootsFor(await knownProjects(home), project)
  const hits = (await Promise.all(roots.map(readBatches))).flat().flatMap(read => {
    const pin = read.batch.pins.find(candidate => annotationId(read.folder, candidate.n) === id)
    return pin ? [{ batch: read.batch, pin, dir: annotationDir(read), root: read.root }] : []
  })
  if (hits.length > 1) throw new AmbiguousAnnotationError(id, hits.map(hit => hit.root))
  return hits[0] ?? null
}

export async function getAnnotation(args: {
  readonly home: string
  readonly id: string
  readonly project?: string
}): Promise<AnnotationDetail | null> {
  const found = await locate(args)
  if (!found) return null
  const { pin, dir, root } = found
  return {
    ...pin,
    id: args.id,
    project: root,
    cropFile: join(dir, pin.cropFile),
    recaptures: pin.recaptures.map(recapture => ({ ...recapture, afterFile: join(dir, recapture.afterFile) })),
  }
}

const updateQueues = new Map<string, Promise<unknown>>()

async function updatePin({ dir, n, update }: {
  readonly dir: string
  readonly n: number
  readonly update: (pin: StoredPin) => StoredPin
}): Promise<boolean> {
  const file = join(dir, 'batch.json')
  const run = async (): Promise<boolean> => {
    const batch = await readJson(file)
    if (!isStoredBatch(batch) || !batch.pins.some(pin => pin.n === n)) return false
    const pins = batch.pins.map(pin => pin.n === n ? update(pin) : pin)
    await writeFile(file, JSON.stringify({ ...batch, pins }, null, 2))
    return true
  }
  const queued = (updateQueues.get(file) ?? Promise.resolve()).then(run, run)
  updateQueues.set(file, queued)
  return queued
}

export async function resolveAnnotation(args: {
  readonly home: string
  readonly id: string
  readonly summary: string
  readonly project?: string
  readonly now: number
}): Promise<boolean> {
  const found = await locate(args)
  if (!found) return false
  return updatePin({
    dir: found.dir,
    n: found.pin.n,
    update: pin => ({ ...pin, status: 'resolved', summary: args.summary, resolvedAt: args.now }),
  })
}
