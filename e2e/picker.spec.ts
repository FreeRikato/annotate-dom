import { type BrowserContext, type Locator, type Page, type Worker, chromium, expect, test } from '@playwright/test'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXTENSION = resolve(import.meta.dirname, '../dist-test')
const REPO = resolve(import.meta.dirname, '..')

test.describe.configure({ mode: 'serial' })

let fixture: ChildProcess
let fixtureUrl: string
let context: BrowserContext
let worker: Worker
let page: Page
let overlay: Locator

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

async function toggleOverlay(): Promise<void> {
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    const toggle: unknown = Reflect.get(globalThis, 'annotateDomToggle')
    if (typeof toggle === 'function') await toggle(tab)
  })
}

async function pin(element: Locator, note: string, count: number): Promise<void> {
  await element.click()
  await overlay.locator('.editor textarea').fill(note)
  await overlay.locator('.editor textarea').press('Enter')
  await expect(overlay.locator('.title')).toHaveText(`annotate-dom (${count})`, { timeout: 20_000 })
}

test.beforeAll(async () => {
  test.skip(!existsSync(join(EXTENSION, 'manifest.json')), 'dist-test is missing: run bun run build:test')
  const port = await freePort()
  fixtureUrl = `http://localhost:${port}`
  fixture = spawn('bun', [join(REPO, 'e2e/fixture-server.ts')], {
    env: { ...process.env, FIXTURE_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  await expect.poll(() => fetch(`${fixtureUrl}/settings`).then(() => true, () => false), { timeout: 15_000 }).toBe(true)
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'annotate-dom-profile-')), {
    channel: 'chromium',
    headless: true,
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  })
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  page = await context.newPage()
  overlay = page.locator('annotate-dom-root')
})

test.afterAll(async () => {
  await context?.close()
  fixture?.kill()
})

test('a pin made on #/a shows under #/a only, and an anchor jump keeps the current page', async () => {
  await page.goto(`${fixtureUrl}/router#/a`)
  await toggleOverlay()
  await expect(overlay.locator('.panel')).toBeVisible()

  await pin(page.locator('#action'), 'save should confirm', 1)
  await expect(overlay.locator('.marker')).toHaveCount(1)
  await expect(overlay.locator('.list .group')).toHaveText('/router#/a (this page)')

  await page.evaluate(() => (location.hash = '#/b'))
  await expect(page.locator('#action')).toHaveText('Save page B')
  await expect(overlay.locator('.marker')).toHaveCount(0)
  await expect(overlay.locator('.list .group')).toHaveText('/router#/a')

  await page.evaluate(() => (location.hash = '#/a'))
  await expect(overlay.locator('.marker')).toHaveCount(1)
  await expect(overlay.locator('.list .group')).toHaveText('/router#/a (this page)')

  await page.goto(`${fixtureUrl}/router`)
  await toggleOverlay()
  await expect(overlay.locator('.panel')).toBeVisible()
  await expect(overlay.locator('.title')).toHaveText('annotate-dom (1)')
  await expect(overlay.locator('.marker')).toHaveCount(0)
  await pin(page.locator('#top'), 'heading is too plain', 2)
  await expect(overlay.locator('.marker')).toHaveCount(1)
  await page.evaluate(() => (location.hash = '#top'))
  await expect(overlay.locator('.marker')).toHaveCount(1)
  await expect(overlay.locator('.list .group').filter({ hasText: '(this page)' })).toHaveText('/router (this page)')
})

test('the chosen detail level shapes Copy all and survives closing the overlay and reloading the tab', async () => {
  const tab = await context.newPage()
  await tab.bringToFront()
  const tabOverlay = tab.locator('annotate-dom-root')
  await tab.goto(`${fixtureUrl}/settings`)
  await toggleOverlay()
  await expect(tabOverlay.locator('.panel')).toBeVisible()
  await expect(tabOverlay.getByLabel('Detail level')).toHaveValue('standard')

  await tabOverlay.getByLabel('Detail level').selectOption('compact')
  await tab.locator('#theme').click()
  await tabOverlay.locator('.editor textarea').fill('toggle needs less padding')
  await tabOverlay.locator('.editor textarea').press('Enter')
  await expect(tabOverlay.locator('.title')).toHaveText('annotate-dom (1)', { timeout: 20_000 })
  await tabOverlay.getByRole('button', { name: 'Copy all' }).click()
  await expect(tabOverlay.locator('.toast')).toContainText('Copied 1 annotation', { timeout: 20_000 })
  const markdown = await tab.evaluate(() => navigator.clipboard.readText())
  expect(markdown).toMatch(/^1\. \*\*.+\*\* \(.+\): toggle needs less padding$/m)
  expect(markdown).not.toContain('### 1.')

  await toggleOverlay()
  await expect(tabOverlay.locator('.panel')).toBeHidden()
  await toggleOverlay()
  await expect(tabOverlay.getByLabel('Detail level')).toHaveValue('compact')

  await tab.reload()
  await toggleOverlay()
  await expect(tabOverlay.locator('.panel')).toBeVisible()
  await expect(tabOverlay.getByLabel('Detail level')).toHaveValue('compact')
  await tabOverlay.getByLabel('Detail level').selectOption('standard')
  await tab.close()
})

test('hovering and clicking pick the button under a transparent full-screen backdrop', async () => {
  const tab = await context.newPage()
  await tab.bringToFront()
  const tabOverlay = tab.locator('annotate-dom-root')
  await tab.goto(`${fixtureUrl}/backdrop`)
  await toggleOverlay()
  await expect(tabOverlay.locator('.panel')).toBeVisible()

  const box = await tab.locator('#go').boundingBox()
  if (!box) throw new Error('button has no box')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await tab.mouse.move(x, y)
  await expect(tabOverlay.locator('.hl-label')).toContainText('button#go')

  await tab.mouse.click(x, y)
  await expect(tabOverlay.locator('.editor textarea')).toBeVisible()
  const editor = await tabOverlay.locator('.editor').boundingBox()
  expect(editor?.y).toBeGreaterThanOrEqual(box.y + box.height)
  await tab.keyboard.press('Escape')
  await tab.close()
})

test('Alt+scroll walks the pick target up its parents and back without scrolling the page', async () => {
  const tab = await context.newPage()
  await tab.bringToFront()
  const tabOverlay = tab.locator('annotate-dom-root')
  await tab.goto(`${fixtureUrl}/nested`)
  await toggleOverlay()
  await expect(tabOverlay.locator('.panel')).toBeVisible()

  const box = await tab.locator('#deep').boundingBox()
  if (!box) throw new Error('button has no box')
  await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await expect(tabOverlay.locator('.hl-label')).toContainText('button#deep')

  await tab.keyboard.down('Alt')
  await tab.mouse.wheel(0, -100)
  await expect(tabOverlay.locator('.hl-label')).toContainText('section#inner')
  await expect(tabOverlay.locator('.hl-label')).toContainText('2/3')
  await tab.mouse.wheel(0, -100)
  await expect(tabOverlay.locator('.hl-label')).toContainText('main#outer')
  await expect(tabOverlay.locator('.hl-label')).toContainText('3/3')
  await tab.mouse.wheel(0, -100)
  await expect(tabOverlay.locator('.hl-label')).toContainText('3/3')
  expect(await tab.evaluate(() => scrollY)).toBe(0)

  await tab.mouse.wheel(0, 100)
  await expect(tabOverlay.locator('.hl-label')).toContainText('2/3')

  await tab.keyboard.up('Alt')
  await expect(tabOverlay.locator('.hl-label')).toContainText('button#deep')
  await expect(tabOverlay.locator('.hl-label')).not.toContainText('/3')
  await tab.mouse.wheel(0, 200)
  await expect.poll(() => tab.evaluate(() => scrollY)).toBeGreaterThan(0)
  await tab.evaluate(() => scrollTo(0, 0))

  await tab.keyboard.down('Alt')
  await tab.mouse.wheel(0, -100)
  await tab.mouse.wheel(0, -100)
  await expect(tabOverlay.locator('.hl-label')).toContainText('3/3')
  const outer = await tab.locator('#outer').boundingBox()
  if (!outer) throw new Error('outer has no box')
  await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await tab.keyboard.up('Alt')
  await expect(tabOverlay.locator('.editor textarea')).toBeVisible()
  const editor = await tabOverlay.locator('.editor').boundingBox()
  expect(editor?.y).toBeGreaterThanOrEqual(outer.y + outer.height)
  await tab.keyboard.press('Escape')
  await tab.close()
})

test('Shift+click copies one element without a pin or screenshot, and a plain click still opens the editor', async () => {
  const tab = await context.newPage()
  await tab.bringToFront()
  const tabOverlay = tab.locator('annotate-dom-root')
  await tab.goto(`${fixtureUrl}/settings`)
  await toggleOverlay()
  await expect(tabOverlay.locator('.panel')).toBeVisible()
  const title = await tabOverlay.locator('.title').textContent()
  const downloads = () => worker.evaluate(async () => (await chrome.downloads.search({})).length)
  const downloadsBefore = await downloads()

  await tab.locator('#theme').click({ modifiers: ['Shift'] })
  await expect(tabOverlay.locator('.toast')).toContainText('Copied ', { timeout: 20_000 })
  const toast = (await tabOverlay.locator('.toast').textContent()) ?? ''
  const selector = toast.replace(/^Copied /, '').replace(/Undo$/, '')
  const markdown = await tab.evaluate(() => navigator.clipboard.readText())
  expect(markdown).toContain(`### ${selector}\n`)
  expect(markdown).toContain(`- Selector: \`${selector}\``)
  await expect(tabOverlay.locator('.title')).toHaveText(title ?? '')
  await expect(tabOverlay.locator('.marker')).toHaveCount(0)
  expect(await downloads()).toBe(downloadsBefore)
  await expect(tabOverlay.locator('.editor textarea')).toBeHidden()

  await tab.locator('#theme').click()
  await expect(tabOverlay.locator('.editor textarea')).toBeVisible()
  await tabOverlay.locator('.editor textarea').fill('first')
  await tabOverlay.locator('.editor textarea').press('Shift+Enter')
  await tabOverlay.locator('.editor textarea').pressSequentially('second')
  await expect(tabOverlay.locator('.editor textarea')).toHaveValue('first\nsecond')
  await expect(tabOverlay.locator('.title')).toHaveText(title ?? '')
  await tab.keyboard.press('Escape')
  await tab.close()
})

test('text highlighted before a normal pin reaches Copy all', async () => {
  const tab = await context.newPage()
  await tab.bringToFront()
  const tabOverlay = tab.locator('annotate-dom-root')
  await tab.goto(`${fixtureUrl}/settings`)
  await toggleOverlay()
  await expect(tabOverlay.locator('.panel')).toBeVisible()

  await tab.evaluate(() => {
    const heading = document.querySelector('h1')
    const selection = getSelection()
    if (!heading || !selection) throw new Error('fixture has no heading or selection')
    selection.selectAllChildren(heading)
  })
  await tab.locator('h1').click()
  await tabOverlay.locator('.editor textarea').fill('heading is too plain')
  await tabOverlay.locator('.editor textarea').press('Enter')
  await expect(tabOverlay.locator('.title')).toHaveText('annotate-dom (1)', { timeout: 20_000 })
  await tabOverlay.getByRole('button', { name: 'Copy all' }).click()
  await expect(tabOverlay.locator('.toast')).toContainText('Copied 1 annotation', { timeout: 20_000 })
  expect(await tab.evaluate(() => navigator.clipboard.readText())).toContain('Selected text: "Settings"')
  await tab.close()
})

test('the level menu follows a level saved from another tab', async () => {
  const first = await context.newPage()
  const second = await context.newPage()
  const firstOverlay = first.locator('annotate-dom-root')
  const secondOverlay = second.locator('annotate-dom-root')
  await first.goto(`${fixtureUrl}/settings`)
  await first.bringToFront()
  await toggleOverlay()
  await expect(firstOverlay.getByLabel('Detail level')).toHaveValue('standard')
  await second.goto(`${fixtureUrl}/settings`)
  await second.bringToFront()
  await toggleOverlay()
  await expect(secondOverlay.getByLabel('Detail level')).toHaveValue('standard')

  await secondOverlay.getByLabel('Detail level').selectOption('compact')
  await expect(firstOverlay.getByLabel('Detail level')).toHaveValue('compact')

  await secondOverlay.getByLabel('Detail level').selectOption('standard')
  await first.close()
  await second.close()
})
