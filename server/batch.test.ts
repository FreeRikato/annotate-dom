import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toMarkdown } from '../src/lib/markdown'
import type { Inspection } from '../src/lib/types'
import { type StoredBatch, type WireBatch, writeBatch } from './batch'

const png = 'data:image/png;base64,' + Buffer.from('png-bytes').toString('base64')

const inspection: Inspection = {
  selector: 'button', tag: 'button', html: '<button>Save</button>', htmlTruncated: false, text: 'Save',
  box: { x: 1, y: 2, w: 3, h: 4 }, styles: { color: 'red' }, attributes: {}, ancestors: [],
  viewport: { width: 800, height: 600, dpr: 2 }, react: null,
}

function wireBatch(overrides: Partial<WireBatch> = {}): WireBatch {
  return {
    origin: 'http://localhost:3000',
    createdAt: new Date(2026, 9, 27, 14, 5).getTime(),
    pages: [{ path: '/settings', url: 'http://localhost:3000/settings', viewport: png }],
    pins: [1, 2].map(n => ({
      n, id: `p${n}`, path: '/settings', url: 'http://localhost:3000/settings', note: `note ${n}`,
      createdAt: 1, inspection, elementSite: { file: 'src/Form.tsx', line: 4, column: 2 },
      callSites: [{ name: 'Form', loc: { file: '/x/app/src/Page.tsx', line: 9, column: 1 } }], crop: png,
    })),
    ...overrides,
  }
}

let dir: string
let root: string
let home: string

const git = (...args: string[]) => Bun.spawn(['git', '-C', root, ...args], { stdout: 'pipe' }).exited

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'batch-')))
  root = join(dir, 'app')
  home = join(dir, 'home')
  await mkdir(root, { recursive: true })
  await git('init', '-q')
})

afterEach(() => rm(dir, { recursive: true, force: true }))

test('writes the folder named by time and first page slug with every file', async () => {
  const { folder, prompt } = await writeBatch({ root, home, batch: wireBatch() })
  expect(folder).toBe('2026-10-27-1405-settings')
  expect(prompt).toBe('Fix the annotations in .annotations/2026-10-27-1405-settings/')
  const files = (await readdir(join(root, '.annotations', folder))).sort()
  expect(files).toEqual(['batch.json', 'batch.md', 'pin-1.png', 'pin-2.png', 'viewport-settings.png'])
  expect(await readFile(join(root, '.annotations', folder, 'pin-1.png'), 'utf8')).toBe('png-bytes')
})

test('a second batch in the same minute gets a numeric suffix', async () => {
  await writeBatch({ root, home, batch: wireBatch() })
  const second = await writeBatch({ root, home, batch: wireBatch() })
  const third = await writeBatch({ root, home, batch: wireBatch() })
  expect([second.folder, third.folder]).toEqual(['2026-10-27-1405-settings-2', '2026-10-27-1405-settings-3'])
})

test('the root page path slugs to index', async () => {
  const batch = wireBatch({ pages: [{ path: '/', url: 'http://localhost:3000/', viewport: null }] })
  const { folder } = await writeBatch({ root, home, batch })
  expect(folder).toBe('2026-10-27-1405-index')
})

test('batch.json holds open pins, relative file names and absolute source paths', async () => {
  const { folder } = await writeBatch({ root, home, batch: wireBatch() })
  const stored: StoredBatch = JSON.parse(await readFile(join(root, '.annotations', folder, 'batch.json'), 'utf8'))
  expect(stored).toMatchObject({
    version: 1, folder, project: root, origin: 'http://localhost:3000',
    pages: [{ path: '/settings', url: 'http://localhost:3000/settings', viewportFile: 'viewport-settings.png' }],
  })
  expect(stored.pins.map(p => p.n)).toEqual([1, 2])
  for (const pin of stored.pins) {
    expect(pin).toMatchObject({ status: 'open', summary: null, resolvedAt: null, recaptures: [], excerpts: [] })
    expect(pin).not.toHaveProperty('crop')
    expect(pin.cropFile).toBe(`pin-${pin.n}.png`)
    expect(pin.elementSite?.file).toBe(join(root, 'src/Form.tsx'))
    expect(pin.callSites[0]?.loc?.file).toBe('/x/app/src/Page.tsx')
  }
})

test('batch.md is toMarkdown of the stored batch with relative file names', async () => {
  const { folder } = await writeBatch({ root, home, batch: wireBatch() })
  const dirPath = join(root, '.annotations', folder)
  const stored: StoredBatch = JSON.parse(await readFile(join(dirPath, 'batch.json'), 'utf8'))
  const expected = toMarkdown({
    origin: stored.origin,
    createdAt: stored.createdAt,
    pages: stored.pages.map(page => ({
      ...page,
      pins: stored.pins.filter(p => p.path === page.path).map(p => ({ pin: { ...p, crop: '' }, cropFile: p.cropFile })),
    })),
  })
  expect(await readFile(join(dirPath, 'batch.md'), 'utf8')).toBe(expected)
  expect(expected).toContain('- Screenshot: pin-1.png')
  expect(expected).toContain('- Viewport screenshot (pins numbered): viewport-settings.png')
})

test('.annotations/ is added to the git exclude once and git status stays clean', async () => {
  await writeBatch({ root, home, batch: wireBatch() })
  await writeBatch({ root, home, batch: wireBatch() })
  const exclude = (await readFile(join(root, '.git/info/exclude'), 'utf8')).split('\n')
  expect(exclude.filter(l => l === '.annotations/')).toHaveLength(1)
  const status = await new Response(Bun.spawn(['git', '-C', root, 'status', '--porcelain'], { stdout: 'pipe' }).stdout).text()
  expect(status).toBe('')
})

test('in a git worktree the shared exclude file is used', async () => {
  await writeFile(join(root, 'a.txt'), 'a')
  await git('add', '.')
  await git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
  const tree = join(dir, 'tree')
  await git('worktree', 'add', '-q', tree)
  await writeBatch({ root: tree, home, batch: wireBatch() })
  await writeBatch({ root: tree, home, batch: wireBatch() })
  const exclude = (await readFile(join(root, '.git/info/exclude'), 'utf8')).split('\n')
  expect(exclude.filter(l => l === '.annotations/')).toHaveLength(1)
  const status = await new Response(Bun.spawn(['git', '-C', tree, 'status', '--porcelain'], { stdout: 'pipe' }).stdout).text()
  expect(status).toBe('')
})

test('a root that is not a git repo still gets the batch and no exclude', async () => {
  const plain = join(dir, 'plain')
  await mkdir(plain)
  const { folder } = await writeBatch({ root: plain, home, batch: wireBatch() })
  expect(await readdir(join(plain, '.annotations', folder))).toContain('batch.json')
})

test('projects.json records each root once', async () => {
  await writeBatch({ root, home, batch: wireBatch() })
  await writeBatch({ root, home, batch: wireBatch() })
  expect(JSON.parse(await readFile(join(home, 'projects.json'), 'utf8'))).toEqual([root])
})

test('a malformed projects.json is replaced and the batch is written once', async () => {
  await mkdir(home, { recursive: true })
  for (const [minute, bad] of ['{not json', '{"a":1}', '"text"'].entries()) {
    await writeFile(join(home, 'projects.json'), bad)
    const { folder } = await writeBatch({ root, home, batch: wireBatch({ createdAt: new Date(2026, 9, 27, 14, minute).getTime() }) })
    expect(folder).not.toMatch(/-\d$/)
    expect(JSON.parse(await readFile(join(home, 'projects.json'), 'utf8'))).toEqual([root])
  }
})

test('an exclude file without a trailing newline keeps its last line intact', async () => {
  await writeFile(join(root, '.git/info/exclude'), '*.log')
  await writeBatch({ root, home, batch: wireBatch() })
  expect((await readFile(join(root, '.git/info/exclude'), 'utf8')).split('\n').filter(Boolean)).toEqual(['*.log', '.annotations/'])
})

test('each pin gets excerpts read from disk for its element site and project call sites', async () => {
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/Form.tsx'), Array.from({ length: 20 }, (_, i) => `form ${i + 1}`).join('\n'))
  const page = join(root, 'src/Page.tsx')
  await writeFile(page, Array.from({ length: 20 }, (_, i) => `page ${i + 1}`).join('\n'))
  const lib = join(root, 'node_modules/ui/index.js')
  await mkdir(join(lib, '..'), { recursive: true })
  await writeFile(lib, 'lib')
  const batch = wireBatch({
    pins: wireBatch().pins.map(pin => ({
      ...pin,
      inspection: { ...inspection, react: { elementStack: 'x', owners: [{ name: 'Form', env: 'client', stack: 'x', props: null, state: null }] } },
      callSites: [
        { name: 'Form', loc: { file: page, line: 9, column: 1 } },
        { name: 'Ui', loc: { file: lib, line: 1, column: 1 } },
      ],
    })),
  })
  const { folder } = await writeBatch({ root, home, batch })
  const dirPath = join(root, '.annotations', folder)
  const stored: StoredBatch = JSON.parse(await readFile(join(dirPath, 'batch.json'), 'utf8'))
  expect(stored.pins[0]?.excerpts).toEqual([
    { file: join(root, 'src/Form.tsx'), line: 4, startLine: 1, code: ['form 1', 'form 2', 'form 3', 'form 4', 'form 5', 'form 6', 'form 7', 'form 8', 'form 9'].join('\n') },
    { file: page, line: 9, startLine: 4, code: Array.from({ length: 11 }, (_, i) => `page ${i + 4}`).join('\n') },
  ])
  const markdown = await readFile(join(dirPath, 'batch.md'), 'utf8')
  expect(markdown).toContain(`- Code around ${page}:9 (lines 4 to 14):\n\n\`\`\`\`\npage 4\n`)
  expect(markdown).not.toContain('node_modules/ui')
})
