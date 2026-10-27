import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cwdOfListeningPort, findProjectRoot } from './root'

let dir: string

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'root-')))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

const noPort = async () => null

test('absolute source path with no .git above it walks up to the nearest package.json', async () => {
  await mkdir(join(dir, 'app/components'), { recursive: true })
  await writeFile(join(dir, 'app/package.json'), '{}')
  const root = await findProjectRoot({
    sourceFiles: [join(dir, 'app/components/a.tsx')],
    pageUrls: ['http://localhost:3000/'],
    cwdOfPort: noPort,
  })
  expect(root).toBe(join(dir, 'app'))
})

test('a .git file or folder also marks the root', async () => {
  await mkdir(join(dir, 'repo/src'), { recursive: true })
  await writeFile(join(dir, 'repo/.git'), 'gitdir: elsewhere')
  const root = await findProjectRoot({
    sourceFiles: [join(dir, 'repo/src/a.tsx')],
    pageUrls: [],
    cwdOfPort: noPort,
  })
  expect(root).toBe(join(dir, 'repo'))
})

test('in a monorepo the repo root holding .git wins over the nearest package.json', async () => {
  await mkdir(join(dir, 'mono/.git'), { recursive: true })
  await mkdir(join(dir, 'mono/packages/ui/src'), { recursive: true })
  await writeFile(join(dir, 'mono/package.json'), '{}')
  await writeFile(join(dir, 'mono/packages/ui/package.json'), '{}')
  const root = await findProjectRoot({
    sourceFiles: [join(dir, 'mono/packages/ui/src/a.tsx')],
    pageUrls: [],
    cwdOfPort: noPort,
  })
  expect(root).toBe(join(dir, 'mono'))
})

test('a package.json below a .git file also resolves to the .git directory', async () => {
  await mkdir(join(dir, 'tree/apps/web'), { recursive: true })
  await writeFile(join(dir, 'tree/.git'), 'gitdir: elsewhere')
  await writeFile(join(dir, 'tree/apps/web/package.json'), '{}')
  expect(await findProjectRoot({ sourceFiles: [], pageUrls: ['http://localhost:5173/'], cwdOfPort: async () => join(dir, 'tree/apps/web') }))
    .toBe(join(dir, 'tree'))
})

test('absolute paths inside node_modules are skipped in favour of project paths', async () => {
  await mkdir(join(dir, 'app/node_modules/lib'), { recursive: true })
  await writeFile(join(dir, 'app/package.json'), '{}')
  await writeFile(join(dir, 'app/node_modules/lib/package.json'), '{}')
  const root = await findProjectRoot({
    sourceFiles: [join(dir, 'app/node_modules/lib/index.js'), join(dir, 'app/a.tsx')],
    pageUrls: [],
    cwdOfPort: noPort,
  })
  expect(root).toBe(join(dir, 'app'))
})

test('relative source paths use the cwd of the process listening on the page port', async () => {
  await mkdir(join(dir, 'vite/src'), { recursive: true })
  await writeFile(join(dir, 'vite/package.json'), '{}')
  const asked: number[] = []
  const root = await findProjectRoot({
    sourceFiles: ['src/App.tsx'],
    pageUrls: ['http://localhost:5173/settings'],
    cwdOfPort: async port => {
      asked.push(port)
      return join(dir, 'vite/src')
    },
  })
  expect(root).toBe(join(dir, 'vite'))
  expect(asked).toEqual([5173])
})

test('no absolute path and no listening process refuses', async () => {
  const root = await findProjectRoot({
    sourceFiles: ['src/App.tsx'],
    pageUrls: ['http://localhost:5173/'],
    cwdOfPort: noPort,
  })
  expect(root).toBeNull()
})

test('a cwd with neither .git nor package.json above it refuses', async () => {
  await mkdir(join(dir, 'bare'), { recursive: true })
  const root = await findProjectRoot({
    sourceFiles: [],
    pageUrls: ['http://localhost:5173/'],
    cwdOfPort: async () => join(dir, 'bare'),
  })
  expect(root).toBeNull()
})

test('cwdOfListeningPort finds the cwd of a real listening child process', async () => {
  await mkdir(join(dir, 'child'), { recursive: true })
  const child = Bun.spawn(
    ['bun', '-e', 'const s = Bun.serve({ port: 0, fetch: () => new Response("x") }); console.log(s.port)'],
    { cwd: join(dir, 'child'), stdout: 'pipe' },
  )
  try {
    const reader = child.stdout.getReader()
    const { value } = await reader.read()
    const port = Number(new TextDecoder().decode(value).trim())
    expect(await cwdOfListeningPort(port)).toBe(join(dir, 'child'))
  } finally {
    child.kill()
  }
})

test('cwdOfListeningPort returns null when nothing listens', async () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('x') })
  const port = probe.port ?? 0
  await probe.stop(true)
  expect(await cwdOfListeningPort(port)).toBeNull()
})

test('a page url without a port never asks for a listening process', async () => {
  const asked: number[] = []
  const root = await findProjectRoot({
    sourceFiles: [],
    pageUrls: ['https://example.com/'],
    cwdOfPort: async port => {
      asked.push(port)
      return dir
    },
  })
  expect(root).toBeNull()
  expect(asked).toEqual([])
})
