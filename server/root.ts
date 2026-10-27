import { access } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

export type FindRootInput = {
  readonly sourceFiles: readonly string[]
  readonly pageUrls: readonly string[]
  readonly cwdOfPort: (port: number) => Promise<string | null>
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

async function walkUpToRoot(start: string): Promise<string | null> {
  let nearestPackage: string | null = null
  for (let dir = start, parent = dirname(dir); ; dir = parent, parent = dirname(dir)) {
    if (await exists(join(dir, '.git'))) return dir
    if (nearestPackage === null && (await exists(join(dir, 'package.json')))) nearestPackage = dir
    if (parent === dir) return nearestPackage
  }
}

async function run(command: readonly string[]): Promise<string> {
  const proc = Bun.spawn([...command], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return text
}

export async function cwdOfListeningPort(port: number): Promise<string | null> {
  const pid = (await run(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])).split('\n')[0]
  if (!pid) return null
  const cwdLine = (await run(['lsof', '-a', '-p', pid, '-d', 'cwd', '-Fn'])).split('\n').find(l => l.startsWith('n'))
  return cwdLine ? cwdLine.slice(1) : null
}

export async function findProjectRoot({ sourceFiles, pageUrls, cwdOfPort }: FindRootInput): Promise<string | null> {
  const absolute = sourceFiles.find(f => isAbsolute(f) && !f.includes('/node_modules/'))
  if (absolute) return walkUpToRoot(dirname(absolute))
  for (const url of pageUrls) {
    const port = Number(new URL(url).port)
    if (!port) continue
    const cwd = await cwdOfPort(port)
    if (cwd) return walkUpToRoot(cwd)
  }
  return null
}
