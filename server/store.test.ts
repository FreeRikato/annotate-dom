import { afterEach, beforeEach, expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Inspection } from '../src/lib/types'
import type { StoredBatch, StoredPin } from './batch'
import { AmbiguousAnnotationError, getAnnotation, listAnnotations, resolveAnnotation } from './store'

const inspection: Inspection = {
  selector: 'button', tag: 'button', html: '<button>Save</button>', htmlTruncated: false, text: 'Save',
  box: { x: 1, y: 2, w: 3, h: 4 }, styles: {}, attributes: {}, ancestors: [],
  viewport: { width: 800, height: 600, dpr: 2 }, react: null,
}

function pinOf(n: number, note: string, path = '/settings'): StoredPin {
  return {
    n, id: `p${n}`, path, url: `http://localhost:3000${path}`, note, createdAt: 1, inspection,
    elementSite: { file: '/x/app/a.tsx', line: 4, column: 2 }, callSites: [], cropFile: `pin-${n}.png`,
    excerpts: [], status: 'open', summary: null, resolvedAt: null, recaptures: [],
  }
}

let dir: string
let home: string

async function seed(root: string, folder: string, createdAt: number, pins: StoredPin[]): Promise<void> {
  const batch: StoredBatch = {
    version: 1, folder, project: root, origin: 'http://localhost:3000', createdAt,
    pages: [{ path: '/settings', url: 'http://localhost:3000/settings', viewportFile: null }], pins,
  }
  await mkdir(join(root, '.annotations', folder), { recursive: true })
  await writeFile(join(root, '.annotations', folder, 'batch.json'), JSON.stringify(batch))
}

async function register(...roots: string[]): Promise<void> {
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'projects.json'), JSON.stringify(roots))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'store-'))
  home = join(dir, 'home')
})

afterEach(() => rm(dir, { recursive: true, force: true }))

test('list drops resolved pins, sorts newest batch first and ids are folder#n', async () => {
  const root = join(dir, 'app')
  await seed(root, 'old', 1, [pinOf(1, 'old note')])
  await seed(root, 'new', 2, [pinOf(1, 'first'), { ...pinOf(2, 'done'), status: 'resolved' }])
  await register(root)
  const open = await listAnnotations({ home, project: root, status: 'open' })
  expect(open.map(a => [a.id, a.note])).toEqual([['new#1', 'first'], ['old#1', 'old note']])
  expect((await listAnnotations({ home, project: root, status: 'resolved' })).map(a => a.id)).toEqual(['new#2'])
})

test('a project argument matches the root or a subdirectory of it and no other project', async () => {
  const app = join(dir, 'app')
  const other = join(dir, 'other')
  await seed(app, 'a', 1, [pinOf(1, 'app pin')])
  await seed(other, 'b', 2, [pinOf(1, 'other pin')])
  await register(app, other)
  expect((await listAnnotations({ home, project: join(app, 'src/deep'), status: 'open' })).map(a => a.note)).toEqual(['app pin'])
  expect((await listAnnotations({ home, project: app + '-sibling', status: 'open' }))).toEqual([])
  const all = await listAnnotations({ home, status: 'open' })
  expect(all.map(a => [a.note, a.project])).toEqual([['other pin', other], ['app pin', app]])
})

test('get returns the pin with absolute png paths and null for an unknown id', async () => {
  const root = join(dir, 'app')
  const withRecapture = { ...pinOf(1, 'n'), recaptures: [{ at: 5, afterFile: 'pin-1-after.png', styleDiff: [], htmlChanged: false }] }
  await seed(root, 'a', 1, [withRecapture])
  await register(root)
  const found = await getAnnotation({ home, id: 'a#1' })
  expect(found?.cropFile).toBe(join(root, '.annotations/a/pin-1.png'))
  expect(found?.recaptures[0]?.afterFile).toBe(join(root, '.annotations/a/pin-1-after.png'))
  expect(await getAnnotation({ home, id: 'a#9' })).toBeNull()
})

test('resolve changes only that pin\'s status, summary and resolvedAt and moves no file', async () => {
  const root = join(dir, 'app')
  await seed(root, 'a', 1, [pinOf(1, 'one'), pinOf(2, 'two')])
  await register(root)
  const before = await readdir(join(root, '.annotations/a'))
  expect(await resolveAnnotation({ home, id: 'a#2', summary: 'Disabled Save', now: 99 })).toBe(true)
  const saved: StoredBatch = JSON.parse(await readFile(join(root, '.annotations/a/batch.json'), 'utf8'))
  expect(saved.pins[0]).toEqual(pinOf(1, 'one'))
  expect(saved.pins[1]).toEqual({ ...pinOf(2, 'two'), status: 'resolved', summary: 'Disabled Save', resolvedAt: 99 })
  expect(await readdir(join(root, '.annotations/a'))).toEqual(before)
  expect(await resolveAnnotation({ home, id: 'a#7', summary: 'x', now: 1 })).toBe(false)
})

test('parallel resolves of pins in one batch all land', async () => {
  const root = join(dir, 'app')
  await seed(root, 'a', 1, [pinOf(1, 'one'), pinOf(2, 'two'), pinOf(3, 'three')])
  await register(root)
  await Promise.all([1, 2, 3].map(n => resolveAnnotation({ home, id: `a#${n}`, summary: `fix ${n}`, now: n })))
  const saved: StoredBatch = JSON.parse(await readFile(join(root, '.annotations/a/batch.json'), 'utf8'))
  expect(saved.pins.map(pin => [pin.status, pin.summary])).toEqual([['resolved', 'fix 1'], ['resolved', 'fix 2'], ['resolved', 'fix 3']])
})

test('an id found in two projects is ambiguous without a project and resolves in the named one', async () => {
  const one = join(dir, 'one')
  const two = join(dir, 'two')
  await seed(one, 'same', 1, [pinOf(1, 'in one')])
  await seed(two, 'same', 2, [pinOf(1, 'in two')])
  await register(one, two)
  await expect(getAnnotation({ home, id: 'same#1' })).rejects.toBeInstanceOf(AmbiguousAnnotationError)
  await expect(resolveAnnotation({ home, id: 'same#1', summary: 'x', now: 1 })).rejects.toBeInstanceOf(AmbiguousAnnotationError)
  expect(await resolveAnnotation({ home, id: 'same#1', project: two, summary: 'fixed two', now: 5 })).toBe(true)
  const savedOne: StoredBatch = JSON.parse(await readFile(join(one, '.annotations/same/batch.json'), 'utf8'))
  const savedTwo: StoredBatch = JSON.parse(await readFile(join(two, '.annotations/same/batch.json'), 'utf8'))
  expect([savedOne.pins[0]?.status, savedTwo.pins[0]?.status]).toEqual(['open', 'resolved'])
})

test('a copied project resolves and reports paths in the folder it was read from', async () => {
  const app = join(dir, 'app')
  const copy = join(dir, 'app-copy')
  await seed(app, 'a', 1, [pinOf(1, 'one')])
  await cp(app, copy, { recursive: true })
  await register(copy)
  expect(await resolveAnnotation({ home, id: 'a#1', project: copy, summary: 'copy fix', now: 2 })).toBe(true)
  const savedApp: StoredBatch = JSON.parse(await readFile(join(app, '.annotations/a/batch.json'), 'utf8'))
  const savedCopy: StoredBatch = JSON.parse(await readFile(join(copy, '.annotations/a/batch.json'), 'utf8'))
  expect([savedApp.pins[0]?.status, savedCopy.pins[0]?.status]).toEqual(['open', 'resolved'])
  expect((await getAnnotation({ home, id: 'a#1', project: copy }))?.cropFile).toBe(join(copy, '.annotations/a/pin-1.png'))
  expect((await listAnnotations({ home, project: copy, status: 'resolved' })).map(a => a.project)).toEqual([copy])
})
