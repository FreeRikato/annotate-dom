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
    env: { ...process.env, FIXTURE_PORT: String(port), FIXTURE_FOREIGN_PORT: String(await freePort()) },
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

test('Shift+click shows the markdown in the panel when both clipboard paths fail', async () => {
  const tab = await context.newPage()
  await tab.bringToFront()
  const tabOverlay = tab.locator('annotate-dom-root')
  await tab.goto(`${fixtureUrl}/settings`)
  await toggleOverlay()
  await expect(tabOverlay.locator('.panel')).toBeVisible()
  const session = await context.newCDPSession(tab)
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

  await tab.locator('#theme').click({ modifiers: ['Shift'] })

  await expect(tabOverlay.locator('.toast span')).toHaveText('Clipboard blocked; markdown is in the panel.', { timeout: 20_000 })
  expect(await tabOverlay.locator('.fallback textarea').inputValue()).toContain('- Selector: `')
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

type Motion = { readonly spin: number; readonly fade: number; readonly waapi: string; readonly videoPaused: boolean }

const readMotion = (tab: Page): Promise<Motion> =>
  tab.evaluate(() => ({
    spin: document.getElementById('spin')?.getBoundingClientRect().width ?? 0,
    fade: document.getElementById('fade')?.getBoundingClientRect().width ?? 0,
    waapi: getComputedStyle(document.getElementById('waapi') ?? document.body).opacity,
    videoPaused: document.querySelector('video')?.paused ?? true,
  }))

test.describe('the page holds still while the note editor is open', () => {
  let tab: Page
  let tabOverlay: Locator

  test.beforeAll(async () => {
    tab = await context.newPage()
    await tab.bringToFront()
    tabOverlay = tab.locator('annotate-dom-root')
    await tab.goto(`${fixtureUrl}/animated`)
    await expect.poll(async () => (await readMotion(tab)).videoPaused).toBe(false)
    await toggleOverlay()
    await expect(tabOverlay.locator('.panel')).toBeVisible()
    await tabOverlay.locator('.hl').evaluate(el => el.animate([{ opacity: 1 }, { opacity: 0.9 }], { duration: 1000, iterations: Infinity }))
  })

  test.afterAll(async () => {
    await tab.close()
  })

  async function openEditorOnTarget() {
    await tab.locator('#fade').hover({ force: true })
    await tab.locator('#target').click()
    await expect(tabOverlay.locator('.editor textarea')).toBeVisible()
  }

  async function expectHeld() {
    const before = await readMotion(tab)
    await tab.waitForTimeout(500)
    expect(await readMotion(tab)).toEqual(before)
    expect(before.videoPaused).toBe(true)
  }

  async function expectMoving() {
    await expect.poll(async () => {
      const first = await readMotion(tab)
      await tab.waitForTimeout(300)
      const second = await readMotion(tab)
      return first.spin !== second.spin && first.waapi !== second.waapi && !second.videoPaused
    }).toBe(true)
  }

  async function expectOverlayAnimating() {
    const time = () => tabOverlay.locator('.hl').evaluate(el => Number(el.getAnimations()[0]?.currentTime ?? -1))
    const before = await time()
    await tab.waitForTimeout(200)
    expect(await time()).toBeGreaterThan(before)
  }

  for (const [name, finish] of [
    ['save', async () => {
      await tabOverlay.locator('.editor textarea').fill('hold still')
      await tabOverlay.locator('.editor textarea').press('Enter')
      await expect(tabOverlay.locator('.title')).toHaveText(/annotate-dom \(\d+\)/)
      await expect(tabOverlay.locator('.panel button.primary')).toBeEnabled({ timeout: 20_000 })
    }],
    ['Escape', () => tab.keyboard.press('Escape')],
    ['Cancel', () => tabOverlay.getByRole('button', { name: 'Cancel' }).click()],
  ] as const) {
    test(`animations, transitions and video stay still until ${name}, then move again`, async () => {
      await tab.keyboard.press('Escape')
      await tabOverlay.locator('button', { hasText: 'Pick' }).click()
      await expectMoving()
      await openEditorOnTarget()
      await expectHeld()
      await expectOverlayAnimating()
      await finish()
      await expectMoving()
    })
  }

  test('a pin on an element that changes after the click keeps the click-time state in its crop and text', async () => {
    await tab.keyboard.press('Escape')
    await tabOverlay.locator('button', { hasText: 'Pick' }).click()
    await tab.locator('#late').click()
    await expect(tabOverlay.locator('.editor textarea')).toBeVisible()
    await tab.waitForTimeout(1500)
    expect(await tab.locator('#late').textContent()).toBe('Done')
    await tabOverlay.locator('.editor textarea').fill('what does this say')
    await tabOverlay.locator('.editor textarea').press('Enter')
    await expect(tabOverlay.locator('.title')).toHaveText(/annotate-dom \(\d+\)/)
    await expect(tabOverlay.locator('.panel button.primary')).toBeEnabled({ timeout: 20_000 })

    const crop = await worker.evaluate(async () => {
      const [animated] = await chrome.tabs.query({ url: '*://*/animated' })
      const stored: Record<string, unknown> = await chrome.storage.local.get(`batch:${animated?.id}`)
      const batch = Object.values(stored)[0]
      const pins: unknown = batch && typeof batch === 'object' ? Reflect.get(batch, 'pins') : null
      const last: unknown = Array.isArray(pins) ? pins.at(-1) : null
      const url: unknown = last && typeof last === 'object' ? Reflect.get(last, 'crop') : null
      if (typeof url !== 'string') throw new Error('no crop stored')
      const bitmap = await createImageBitmap(await (await fetch(url)).blob())
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      ctx.drawImage(bitmap, 0, 0)
      const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
      let green = 0
      let red = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 80 && data[i + 1] > 150 && data[i + 2] < 80) green += 1
        if (data[i] > 170 && data[i + 1] < 60 && data[i + 2] < 60) red += 1
      }
      return { green, red }
    })
    expect(crop.green).toBeGreaterThan(crop.red)

    await tabOverlay.getByRole('button', { name: 'Copy all' }).click()
    await expect(tabOverlay.locator('.toast')).toContainText('Copied ', { timeout: 20_000 })
    const markdown = await tab.evaluate(() => navigator.clipboard.readText())
    expect(markdown).toContain('Loading')
    expect(markdown).not.toContain('"Done"')
  })
})

test.describe('motion inside frames and quick re-clicks', () => {
  test('an animation in a same-origin html frame and in an svg frame is held while the editor is open and resumes after save', async () => {
    const tab = await context.newPage()
    await tab.bringToFront()
    const tabOverlay = tab.locator('annotate-dom-root')
    await tab.goto(`${fixtureUrl}/motion-frames`)
    await toggleOverlay()
    await expect(tabOverlay.locator('.panel')).toBeVisible()
    const barWidths = () =>
      Promise.all(['/inner-motion', '/inner-motion.svg'].map(path => {
        const frame = tab.frames().find(f => f.url().endsWith(path))
        if (!frame) throw new Error(`no frame ${path}`)
        return frame.evaluate(() => document.getElementById('bar')?.getBoundingClientRect().width ?? 0)
      }))
    const moving = async () => {
      const first = await barWidths()
      await tab.waitForTimeout(300)
      const second = await barWidths()
      return first[0] !== second[0] && first[1] !== second[1]
    }
    await expect.poll(moving).toBe(true)

    await tab.locator('#target').click()
    await expect(tabOverlay.locator('.editor textarea')).toBeVisible()
    const held = await barWidths()
    await tab.waitForTimeout(500)
    expect(await barWidths()).toEqual(held)

    await tabOverlay.locator('.editor textarea').fill('frames hold still')
    await tabOverlay.locator('.editor textarea').press('Enter')
    await expect(tabOverlay.locator('.title')).toHaveText('annotate-dom (1)', { timeout: 20_000 })
    await expect(tabOverlay.locator('.panel button.primary')).toBeEnabled({ timeout: 20_000 })
    await expect.poll(moving).toBe(true)
    await tab.close()
  })

  test('opening the editor when Chrome refuses the first screenshot for its rate limit retries and opens', async () => {
    const tab = await context.newPage()
    await tab.bringToFront()
    const tabOverlay = tab.locator('annotate-dom-root')
    await tab.goto(`${fixtureUrl}/multi`)
    await toggleOverlay()
    await expect(tabOverlay.locator('.panel')).toBeVisible()
    await worker.evaluate(() => {
      const real = chrome.tabs.captureVisibleTab.bind(chrome.tabs)
      let refused = false
      Reflect.set(globalThis, 'restoreCapture', () => Reflect.set(chrome.tabs, 'captureVisibleTab', real))
      Reflect.set(chrome.tabs, 'captureVisibleTab', async (...args: Parameters<typeof real>) => {
        if (!refused) {
          refused = true
          throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.')
        }
        return real(...args)
      })
    })
    try {
      await tab.locator('#a').click()
      await expect(tabOverlay.locator('.editor textarea')).toBeVisible({ timeout: 5_000 })
      await expect(tabOverlay.locator('.toast')).toBeHidden()
    } finally {
      await worker.evaluate(() => Reflect.get(globalThis, 'restoreCapture')())
      await tab.close()
    }
  })
})

async function greenPixelsInLastCrop(tabUrl: string): Promise<number> {
  return worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url })
    const stored: Record<string, unknown> = await chrome.storage.local.get(`batch:${tab?.id}`)
    const batch = Object.values(stored)[0]
    const pins: unknown = batch && typeof batch === 'object' ? Reflect.get(batch, 'pins') : null
    const last: unknown = Array.isArray(pins) ? pins.at(-1) : null
    const crop: unknown = last && typeof last === 'object' ? Reflect.get(last, 'crop') : null
    if (typeof crop !== 'string') throw new Error('no crop stored')
    const bitmap = await createImageBitmap(await (await fetch(crop)).blob())
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(bitmap, 0, 0)
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    let green = 0
    for (let i = 0; i < data.length; i += 4) if (data[i] < 80 && data[i + 1] > 150 && data[i + 2] < 80) green += 1
    return green
  }, tabUrl)
}

async function copiedMarkdown(tab: Page, tabOverlay: Locator): Promise<string> {
  await tabOverlay.getByRole('button', { name: 'Copy all' }).click()
  await expect(tabOverlay.locator('.toast')).toContainText('Copied ', { timeout: 20_000 })
  return tab.evaluate(() => navigator.clipboard.readText())
}

test.describe('shadow roots and frames', () => {
  test('hovering and clicking inside an open shadow root pins the inner element', async () => {
    const tab = await context.newPage()
    await tab.bringToFront()
    const tabOverlay = tab.locator('annotate-dom-root')
    await tab.goto(`${fixtureUrl}/shadow`)
    await toggleOverlay()
    await expect(tabOverlay.locator('.panel')).toBeVisible()

    await tab.locator('#inner').hover()
    await expect(tabOverlay.locator('.hl-label')).toContainText('button#inner')
    await tab.locator('#inner').click()
    await tabOverlay.locator('.editor textarea').fill('shadow button needs a border')
    await tabOverlay.locator('.editor textarea').press('Enter')
    await expect(tabOverlay.locator('.title')).toHaveText('annotate-dom (1)', { timeout: 20_000 })
    await expect(tabOverlay.locator('.marker')).toHaveCount(1)
    expect(await greenPixelsInLastCrop('*://*/shadow')).toBeGreaterThan(500)
    expect(await copiedMarkdown(tab, tabOverlay)).toContain('#host >>> #inner')
    await tab.close()
  })

  test('hovering and clicking inside a same-origin iframe, and a shadow root in it, pin the inner element', async () => {
    const tab = await context.newPage()
    await tab.bringToFront()
    const tabOverlay = tab.locator('annotate-dom-root')
    await tab.goto(`${fixtureUrl}/frames`)
    await toggleOverlay()
    await expect(tabOverlay.locator('.panel')).toBeVisible()
    const same = tab.frameLocator('#same')

    await same.locator('#plain').hover()
    await expect(tabOverlay.locator('.hl-label')).toContainText('button#plain')
    const outer = await tab.locator('#same').boundingBox()
    const inner = await same.locator('#plain').boundingBox()
    const highlight = await tabOverlay.locator('.hl').boundingBox()
    if (!outer || !inner || !highlight) throw new Error('missing boxes')
    expect(Math.abs(highlight.x - inner.x)).toBeLessThan(2)
    expect(Math.abs(highlight.y - inner.y)).toBeLessThan(2)
    expect(inner.x).toBeGreaterThan(outer.x)
    await same.locator('#plain').click()
    await tabOverlay.locator('.editor textarea').fill('frame button is cramped')
    await tabOverlay.locator('.editor textarea').press('Enter')
    await expect(tabOverlay.locator('.title')).toHaveText('annotate-dom (1)', { timeout: 20_000 })
    await expect(tabOverlay.locator('.marker')).toHaveCount(1)
    expect(await greenPixelsInLastCrop('*://*/frames')).toBeGreaterThan(500)

    await same.locator('#nested').click()
    await tabOverlay.locator('.editor textarea').fill('nested shadow button is cramped')
    await tabOverlay.locator('.editor textarea').press('Enter')
    await expect(tabOverlay.locator('.title')).toHaveText('annotate-dom (2)', { timeout: 20_000 })

    await tab.reload()
    await toggleOverlay()
    await expect(tabOverlay.locator('.marker')).toHaveCount(2)
    const markdown = await copiedMarkdown(tab, tabOverlay)
    expect(markdown).toContain('#same >>> #plain')
    expect(markdown).toContain('#same >>> #host >>> #nested')
    await tab.close()
  })

  test('hovering a cross-origin iframe says it cannot be picked and a click opens no editor', async () => {
    const tab = await context.newPage()
    await tab.bringToFront()
    const tabOverlay = tab.locator('annotate-dom-root')
    await tab.goto(`${fixtureUrl}/frames`)
    await toggleOverlay()
    await expect(tabOverlay.locator('.panel')).toBeVisible()

    const box = await tab.locator('#foreign').boundingBox()
    if (!box) throw new Error('frame has no box')
    await tab.mouse.move(box.x + 40, box.y + 40)
    await expect(tabOverlay.locator('.hl-label')).toContainText('iframe#foreign')
    await expect(tabOverlay.locator('.toast')).toContainText('cannot be picked')
    await tab.mouse.click(box.x + 40, box.y + 40)
    await tab.waitForTimeout(3000)
    await expect(tabOverlay.locator('.editor')).toBeHidden()
    await tab.close()
  })
})
