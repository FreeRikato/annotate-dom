import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readExcerpts } from './excerpt'

let root: string
let outside: string

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`)

async function source(file: string, count: number): Promise<string> {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, lines(count).join('\n') + '\n')
  return file
}

beforeEach(async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'excerpt-')))
  root = join(dir, 'app')
  outside = join(dir, 'other')
  await mkdir(root, { recursive: true })
})

afterEach(() => rm(join(root, '..'), { recursive: true, force: true }))

test('reads 5 lines above and 5 below the site', async () => {
  const file = await source(join(root, 'components/a.tsx'), 100)
  const [excerpt] = await readExcerpts({ root, sites: [{ file, line: 40, column: 1 }] })
  expect(excerpt).toEqual({ file, line: 40, startLine: 35, code: lines(100).slice(34, 45).join('\n') })
})

test('clips at the start of the file', async () => {
  const file = await source(join(root, 'a.tsx'), 100)
  const [excerpt] = await readExcerpts({ root, sites: [{ file, line: 2, column: 1 }] })
  expect(excerpt?.startLine).toBe(1)
  expect(excerpt?.code).toBe(lines(100).slice(0, 7).join('\n'))
})

test('a file shorter than the window is clipped, not padded', async () => {
  const file = await source(join(root, 'a.tsx'), 3)
  const [excerpt] = await readExcerpts({ root, sites: [{ file, line: 2, column: 1 }] })
  expect(excerpt).toEqual({ file, line: 2, startLine: 1, code: 'line 1\nline 2\nline 3' })
})

test('skips node_modules, files outside the root and unreadable files', async () => {
  const lib = await source(join(root, 'node_modules/pkg/index.js'), 20)
  const elsewhere = await source(join(outside, 'b.tsx'), 20)
  const sibling = await source(join(root, '..', 'app-two/c.tsx'), 20)
  const missing = join(root, 'gone.tsx')
  const excerpts = await readExcerpts({
    root,
    sites: [lib, elsewhere, sibling, missing].map(file => ({ file, line: 10, column: 1 })),
  })
  expect(excerpts).toEqual([])
})

test('skips a line past the end of the file and a missing site', async () => {
  const file = await source(join(root, 'a.tsx'), 3)
  expect(await readExcerpts({ root, sites: [{ file, line: 50, column: 1 }, null] })).toEqual([])
})

test('reads a file once for sites that share it and drops an identical site', async () => {
  const file = await source(join(root, 'a.tsx'), 100)
  const excerpts = await readExcerpts({
    root,
    sites: [{ file, line: 10, column: 1 }, { file, line: 10, column: 9 }, { file, line: 80, column: 1 }],
  })
  expect(excerpts.map(e => e.line)).toEqual([10, 80])
})

test('reads only source-code files, never dotfiles, keys, configs or anything under a dot folder', async () => {
  const env = join(root, '.env')
  const key = join(root, 'deploy.pem')
  const gitConfig = join(root, '.git/config')
  const dotSource = join(root, '.hidden/secrets.ts')
  const dotfileSource = join(root, '.env.js')
  const json = join(root, 'credentials.json')
  const ok = join(root, 'src/App.tsx')
  for (const file of [env, key, gitConfig, dotSource, dotfileSource, json, ok]) await source(file, 20)
  const excerpts = await readExcerpts({
    root,
    sites: [env, key, gitConfig, dotSource, dotfileSource, json, ok].map(file => ({ file, line: 10, column: 1 })),
  })
  expect(excerpts.map(e => e.file)).toEqual([ok])
})
