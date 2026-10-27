import { chromium, expect, test } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000'
const APP_ROOT = process.env.APP_ROOT ?? resolve(process.env.HOME ?? '', 'Developer/Personal/granite-inventory-management')
const EXTENSION = resolve(import.meta.dirname, '../dist-test')

const SKIP_APP_SPEC = process.env.SKIP_APP_SPEC === '1'

test.beforeAll(async () => {
  test.skip(SKIP_APP_SPEC, 'SKIP_APP_SPEC=1')
  const daemonRunning = await fetch('http://localhost:4747/health').then(() => true, () => false)
  expect(daemonRunning, 'a daemon holds port 4747, so the button reads Send: stop it to run the Copy all flow').toBe(false)
  const reachable = await fetch(APP_URL).then(() => true, () => false)
  expect(reachable, `APP_URL ${APP_URL} is not reachable: start the app, set APP_URL, or set SKIP_APP_SPEC=1 to skip this spec`).toBe(true)
})

test('pins the login theme toggle and copies markdown with resolved React sources', async () => {
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'annotate-dom-')), {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  })
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const page = await context.newPage()
  await page.goto(`${APP_URL}/login`)
  const toggle = page.locator('button[data-size="icon"]').first()
  await expect.poll(() => toggle.evaluate(el => Object.keys(el).some(k => k.startsWith('__reactFiber$')))).toBe(true)
  const themeBefore = await page.evaluate(() => document.documentElement.className)

  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    const toggleOverlay: unknown = Reflect.get(globalThis, 'annotateDomToggle')
    if (typeof toggleOverlay === 'function') await toggleOverlay(tab)
  })
  const overlay = page.locator('annotate-dom-root')
  await expect(overlay.locator('.panel')).toBeVisible()

  await toggle.click()
  await overlay.locator('.editor textarea').fill('toggle should show the current theme name')
  await overlay.locator('.editor textarea').press('Enter')
  await expect(overlay.locator('.title')).toHaveText('annotate-dom (1)', { timeout: 20_000 })
  expect(await page.evaluate(() => document.documentElement.className)).toBe(themeBefore)

  await overlay.getByRole('button', { name: 'Copy all' }).click()
  await expect(overlay.locator('.toast')).toContainText('Copied 1 annotation', { timeout: 20_000 })
  const markdown = await page.evaluate(() => navigator.clipboard.readText())
  console.log(markdown)

  expect(markdown).toContain('## /login')
  expect(markdown).toContain('### 1. toggle should show the current theme name')
  expect(markdown).toMatch(new RegExp(`- Source: ${APP_ROOT}/components/ui/button\\.tsx:\\d+:\\d+`))
  expect(markdown).toMatch(new RegExp(`\`<Button>\` at ${APP_ROOT}/components/theme-toggle\\.tsx:12:\\d+`))
  expect(markdown).toMatch(new RegExp(`\`<ThemeToggle>\` at ${APP_ROOT}/app/login/page\\.tsx:19:\\d+`))
  expect(markdown).toContain('- Components: LoginPage > ThemeToggle > Button')
  expect(markdown).toContain('`<LoginPage>` (server component) at library code (next/dist/')
  expect(markdown).toContain('- Props of Button: ')

  const files = [...markdown.matchAll(/screenshot[^:]*: (\/\S+)/gi)].map(m => m[1])
  expect(files).toHaveLength(2)
  const saved = resolve(import.meta.dirname, '../test-results/screenshots')
  mkdirSync(saved, { recursive: true })
  for (const [i, file] of files.entries()) {
    expect(existsSync(file), file).toBe(true)
    expect(readFileSync(file).subarray(1, 4).toString()).toBe('PNG')
    copyFileSync(file, join(saved, `${i}.png`))
  }

  await context.close()
})
