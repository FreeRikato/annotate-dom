import { type BrowserContext, type Page, type Worker, chromium, expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'

const EXTENSION = resolve(import.meta.dirname, '../dist-test')
const REPO = resolve(import.meta.dirname, '..')
const DAEMON_PORT = 4747

test.describe.configure({ mode: 'serial' })

let fixture: ChildProcess
let daemon: ChildProcess | null = null
let fixtureUrl: string
let project: string
let home: string
let context: BrowserContext
let worker: Worker
let page: Page

async function freePort(): Promise<number> {
  return new Promise(resolvePort => {
    const probe = createServer()
    probe.listen(0, 'localhost', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') throw new Error('probe has no port')
      probe.close(() => resolvePort(address.port))
    })
  })
}

async function reachable(url: string): Promise<boolean> {
  return fetch(url).then(() => true, () => false)
}

async function startDaemon(): Promise<void> {
  daemon = spawn('bun', ['server/main.ts'], {
    cwd: REPO,
    env: { ...process.env, HOME: home, ANNOTATE_DOM_PORT: String(DAEMON_PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  await expect.poll(() => reachable(`http://localhost:${DAEMON_PORT}/health`), { timeout: 15_000 }).toBe(true)
}

async function stopDaemon(): Promise<void> {
  const stopping = daemon
  if (!stopping) return
  daemon = null
  const exited = new Promise(done => stopping.once('exit', done))
  stopping.kill()
  await exited
}

async function toggleOverlay(): Promise<void> {
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    const toggle: unknown = Reflect.get(globalThis, 'annotateDomToggle')
    if (typeof toggle === 'function') await toggle(tab)
  })
}

async function mcp(args: { name: string; arguments: Record<string, unknown> }): Promise<{ isError: boolean; text: string }> {
  const client = new Client({ name: 'e2e', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${DAEMON_PORT}/mcp`)))
  const result = await client.callTool(args)
  await client.close()
  const first = Array.isArray(result.content) ? result.content[0] : undefined
  const text = first && 'text' in first ? String(first.text) : ''
  return { isError: result.isError === true, text }
}

test.beforeAll(async () => {
  test.skip(await reachable(`http://localhost:${DAEMON_PORT}/health`), `port ${DAEMON_PORT} is taken by a running daemon; stop it to run these tests`)
  test.skip(!existsSync(join(EXTENSION, 'manifest.json')), 'dist-test is missing: run bun run build:test')
  home = mkdtempSync(join(tmpdir(), 'annotate-dom-home-'))
  project = realpathSync(mkdtempSync(join(tmpdir(), 'annotate-dom-project-')))
  writeFileSync(join(project, 'package.json'), '{}')
  mkdirSync(join(project, '.git'))
  const port = await freePort()
  fixtureUrl = `http://localhost:${port}`
  fixture = spawn('bun', [join(REPO, 'e2e/fixture-server.ts')], {
    cwd: project,
    env: { ...process.env, FIXTURE_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  await expect.poll(() => reachable(`${fixtureUrl}/settings`), { timeout: 15_000 }).toBe(true)
  await startDaemon()
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'annotate-dom-profile-')), {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  })
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  page = await context.newPage()
})

test.afterAll(async () => {
  await context?.close()
  await stopDaemon()
  fixture?.kill()
})

test('Send writes the batch folder into the project, copies the prompt and downloads nothing', async () => {
  const downloads: string[] = []
  page.on('download', download => downloads.push(download.suggestedFilename()))
  await page.goto(`${fixtureUrl}/settings`)
  await toggleOverlay()
  const overlay = page.locator('annotate-dom-root')
  await expect(overlay.locator('.panel')).toBeVisible()

  await page.locator('#theme').click()
  await overlay.locator('.editor textarea').fill('toggle needs less padding')
  await overlay.locator('.editor textarea').press('Enter')
  await expect(overlay.locator('.title')).toHaveText('annotate-dom (1)', { timeout: 20_000 })

  await expect(overlay.getByRole('button', { name: 'Send' })).toBeVisible()
  await overlay.getByRole('button', { name: 'Send' }).click()
  await expect(overlay.locator('.toast')).toContainText('Sent 1 annotation', { timeout: 20_000 })

  const [folder] = readdirSync(join(project, '.annotations'))
  expect(folder).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-settings$/)
  const files = readdirSync(join(project, '.annotations', folder))
  expect(files).toEqual(expect.arrayContaining(['batch.json', 'batch.md', 'pin-1.png', 'viewport-settings.png']))
  const batch = JSON.parse(readFileSync(join(project, '.annotations', folder, 'batch.json'), 'utf8'))
  expect(batch.pins[0].note).toBe('toggle needs less padding')
  expect(batch.pins[0].status).toBe('open')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`Fix the annotations in .annotations/${folder}/`)
  expect(downloads).toEqual([])
  await expect(overlay.locator('.title')).toHaveText('annotate-dom (0)')
})

test('the main button reads Copy all while the daemon is stopped and Send again after it starts', async () => {
  const overlay = page.locator('annotate-dom-root')
  await stopDaemon()
  await expect(overlay.getByRole('button', { name: 'Copy all' })).toBeVisible({ timeout: 10_000 })
  await startDaemon()
  await expect(overlay.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 10_000 })
})

const RecaptureSchema = z.object({
  before: z.string(),
  after: z.string(),
  styleDiff: z.array(z.object({ prop: z.string(), before: z.string(), after: z.string() })),
  htmlChanged: z.boolean(),
})

async function recapture(args: Record<string, unknown>) {
  const result = await mcp({ name: 'recapture', arguments: args })
  if (result.isError) throw new Error(result.text)
  return RecaptureSchema.parse(JSON.parse(result.text))
}

test('recapture over MCP on the open tab returns before and after images and the padding diff', async () => {
  const [folder] = readdirSync(join(project, '.annotations'))
  await page.evaluate(() => {
    const theme = document.querySelector('#theme')
    if (theme instanceof HTMLElement) theme.style.padding = '8px 16px'
  })

  const result = await recapture({ id: `${folder}#1`, project })

  expect(result.styleDiff).toContainEqual({ prop: 'padding', before: '8px 24px', after: '8px 16px' })
  expect(existsSync(result.before)).toBe(true)
  expect(existsSync(result.after)).toBe(true)
  expect(readFileSync(result.after).subarray(1, 4).toString()).toBe('PNG')
  expect(readdirSync(join(project, '.annotations', folder))).toContain('pin-1-after.png')
  const batch = JSON.parse(readFileSync(join(project, '.annotations', folder, 'batch.json'), 'utf8'))
  expect(batch.pins[0].recaptures).toHaveLength(1)
})

test('recapture with no tab on the page opens one in the background, closes it and keeps the active tab', async () => {
  const [folder] = readdirSync(join(project, '.annotations'))
  await page.goto('about:blank')
  await fetch(`${fixtureUrl}/set-padding?value=12px`)
  const tabsBefore = context.pages().length
  const activeBefore = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id)

  const result = await recapture({ id: `${folder}#1`, project })

  expect(result.styleDiff).toContainEqual({ prop: 'padding', before: '8px 24px', after: '8px 12px' })
  expect(existsSync(result.after)).toBe(true)
  expect(context.pages()).toHaveLength(tabsBefore)
  expect(await worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id)).toBe(activeBefore)
})

test('a page with no local project falls back to Copy all while the daemon runs', async () => {
  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'annotate-dom-bare-')))
  const port = await freePort()
  const bareFixture = spawn('bun', [join(REPO, 'e2e/fixture-server.ts')], {
    cwd: bare,
    env: { ...process.env, FIXTURE_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  try {
    await expect.poll(() => reachable(`http://localhost:${port}/settings`), { timeout: 15_000 }).toBe(true)
    await page.goto(`http://localhost:${port}/settings`)
    await toggleOverlay()
    const overlay = page.locator('annotate-dom-root')
    await expect(overlay.locator('.panel')).toBeVisible()
    await page.locator('#theme').click()
    await overlay.locator('.editor textarea').fill('no project here')
    await overlay.locator('.editor textarea').press('Enter')
    await expect(overlay.locator('.title')).toHaveText('annotate-dom (1)', { timeout: 20_000 })

    await expect(overlay.getByRole('button', { name: 'Send' })).toBeVisible()
    await overlay.getByRole('button', { name: 'Send' }).click()

    await expect(overlay.locator('.toast')).toContainText('Copied 1 annotation', { timeout: 20_000 })
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('no project here')
    expect(readdirSync(bare)).toEqual([])
    await expect(overlay.locator('.title')).toHaveText('annotate-dom (0)')
  } finally {
    bareFixture.kill()
  }
})

async function blockClipboardInOverlay(): Promise<void> {
  const session = await context.newCDPSession(page)
  const contentWorlds: number[] = []
  session.on('Runtime.executionContextCreated', ({ context: world }) => {
    if (world.origin.startsWith('chrome-extension://')) contentWorlds.push(world.id)
  })
  await session.send('Runtime.enable')
  const stubs = `
    navigator.clipboard.writeText = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'))
    document.execCommand = () => false
  `
  for (const contextId of contentWorlds) await session.send('Runtime.evaluate', { contextId, expression: stubs })
  await session.detach()
}

async function pinTheme(note: string): Promise<void> {
  await page.goto(`${fixtureUrl}/settings`)
  await toggleOverlay()
  const overlay = page.locator('annotate-dom-root')
  await expect(overlay.locator('.panel')).toBeVisible()
  await blockClipboardInOverlay()
  await page.locator('#theme').click()
  await overlay.locator('.editor textarea').fill(note)
  await overlay.locator('.editor textarea').press('Enter')
  await expect(overlay.locator('.title')).toHaveText('annotate-dom (1)', { timeout: 20_000 })
}

test('Send says the clipboard is blocked and shows the prompt when both clipboard paths fail', async () => {
  await pinTheme('clipboard is blocked')
  const overlay = page.locator('annotate-dom-root')

  await overlay.getByRole('button', { name: 'Send' }).click()

  await expect(overlay.locator('.toast span')).toHaveText(
    /^Sent 1 annotation to \.annotations\/\d{4}-\d{2}-\d{2}-\d{4}-settings(-\d+)?\/; clipboard blocked, prompt is in the panel\.$/,
    { timeout: 20_000 },
  )
  const sentFolder = (await overlay.locator('.toast span').innerText()).match(/\.annotations\/([^/]+)\//)?.[1]
  expect(await overlay.locator('.fallback textarea').inputValue()).toBe(`Fix the annotations in .annotations/${sentFolder}/`)
})

test('Copy all says the clipboard is blocked and shows the markdown when both clipboard paths fail', async () => {
  await stopDaemon()
  await pinTheme('clipboard is blocked while the daemon is down')
  const overlay = page.locator('annotate-dom-root')
  await expect(overlay.getByRole('button', { name: 'Copy all' })).toBeVisible({ timeout: 10_000 })

  await overlay.getByRole('button', { name: 'Copy all' }).click()

  await expect(overlay.locator('.toast span')).toHaveText('Clipboard blocked; markdown is in the panel.', { timeout: 20_000 })
  expect(await overlay.locator('.fallback textarea').inputValue()).toContain('clipboard is blocked while the daemon is down')
  await startDaemon()
})
