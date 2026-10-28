import { describe, expect, it } from 'vitest'
import { type ExportPage, toMarkdown } from './markdown'
import type { DetailLevel, Inspection, Pin } from './types'

function firstPage({ pages }: { readonly pages: readonly ExportPage[] }): ExportPage {
  const [page] = pages
  if (!page) throw new Error('batch has no page')
  return page
}

const inspection: Inspection = {
  selector: 'form > button[type="submit"]',
  tag: 'button',
  html: '<button type="submit">Save</button>',
  htmlTruncated: false,
  text: 'Save',
  box: { x: 812, y: 640, w: 96, h: 36 },
  styles: { display: 'inline-flex', color: 'rgb(255, 255, 255)' },
  attributes: { type: 'submit', '(disabled)': 'false' },
  ancestors: [{ selector: 'form.grid', styles: { display: 'grid', gap: '8px' } }],
  viewport: { width: 1440, height: 900, dpr: 2 },
  react: {
    elementStack: 'x',
    owners: [
      { name: 'Button', env: 'client', stack: 'x', props: '{"variant":"default"}', state: null },
      { name: 'ItemForm', env: 'client', stack: 'x', props: '{"mode":"edit"}', state: '["draft"]' },
      { name: 'InventoryPage', env: 'server', stack: 'x', props: null, state: null },
    ],
  },
}

function pin(id: string, path: string, note: string): Pin {
  return {
    id,
    path,
    url: `http://localhost:3000${path}`,
    note,
    createdAt: 0,
    inspection,
    elementSite: { file: '/app/components/ui/button.tsx', line: 58, column: 5 },
    callSites: [
      { name: 'Button', loc: { file: '/app/components/item-form.tsx', line: 88, column: 7 } },
      { name: 'ItemForm', loc: { file: '/app/app/inventory/page.tsx', line: 12, column: 5 } },
      { name: 'InventoryPage', loc: id === 'b' ? { file: '/app/node_modules/.pnpm/next@16.3.4_x/node_modules/next/dist/rsc.js', line: 3524, column: 35 } : null },
    ],
    crop: '',
  }
}

describe('toMarkdown', () => {
  const md = toMarkdown({
    origin: 'http://localhost:3000',
    createdAt: new Date(2026, 9, 26, 14, 2).getTime(),
    pages: [
      { path: '/inventory/new', url: 'http://localhost:3000/inventory/new', viewportFile: '/dl/vp1.png', pins: [{ pin: pin('a', '/inventory/new', 'disable while invalid'), cropFile: '/dl/1.png' }] },
      { path: '/settings', url: 'http://localhost:3000/settings', viewportFile: null, pins: [{ pin: pin('b', '/settings', 'avatar misaligned\nshould sit on the baseline'), cropFile: '/dl/2.png' }] },
    ],
  })

  it('numbers pins across pages and groups them by path', () => {
    expect(md).toContain('# annotate-dom: http://localhost:3000 (2026-10-26 14:02)')
    expect(md).toContain('2 annotations on 2 pages.')
    expect(md).toContain('## /inventory/new')
    expect(md).toContain('### 1. disable while invalid')
    expect(md).toContain('## /settings')
    expect(md).toContain('### 2. avatar misaligned')
    expect(md).toContain('should sit on the baseline')
  })

  it('lists source, components outermost first, and call sites innermost first', () => {
    expect(md).toContain('- Source: /app/components/ui/button.tsx:58:5 (`<button>` element)')
    expect(md).toContain('- Components: InventoryPage > ItemForm > Button')
    expect(md).toContain('  - `<Button>` at /app/components/item-form.tsx:88:7')
    expect(md).toContain('  - `<InventoryPage>` (server component) at unresolved')
    expect(md).toContain('  - `<InventoryPage>` (server component) in next')
    expect(md).not.toContain('library code (')
  })

  it('includes screenshots, viewport, props, state, parents and HTML', () => {
    expect(md).toContain('- Viewport: 1440x900 @2x')
    expect(md).toContain('- Viewport screenshot (pins numbered): /dl/vp1.png')
    expect(md).toContain('- Viewport screenshot (pins numbered): not saved')
    expect(md).toContain('- Screenshot: /dl/1.png')
    expect(md).toContain('- Props of ItemForm: `{"mode":"edit"}`')
    expect(md).toContain('- State of ItemForm (useState/useReducer in hook order): `["draft"]`')
    expect(md).toContain('  - `form.grid`: display: grid; gap: 8px')
    expect(md).toContain('````html\n<button type="submit">Save</button>\n````')
  })

  it('renders each excerpt as a fenced block under the source', () => {
    const withExcerpts = toMarkdown({
      origin: 'http://localhost:3000',
      createdAt: 0,
      pages: [{
        path: '/settings', url: 'http://localhost:3000/settings', viewportFile: null,
        pins: [{
          pin: pin('a', '/settings', 'x'),
          cropFile: null,
          excerpts: [
            { file: '/app/components/ui/button.tsx', line: 58, startLine: 56, code: 'a\nb\nc' },
            { file: '/app/components/item-form.tsx', line: 88, startLine: 88, code: 'd' },
          ],
        }],
      }],
    })
    expect(withExcerpts).toContain(
      '- Source: /app/components/ui/button.tsx:58:5 (`<button>` element)\n' +
      '- Code around /app/components/ui/button.tsx:58 (lines 56 to 58):\n\n````\na\nb\nc\n````\n' +
      '- Code around /app/components/item-form.tsx:88 (lines 88 to 88):\n\n````\nd\n````\n',
    )
    expect(md).not.toContain('Code around')
  })

  it('lists console errors and failed or slow requests only when present', () => {
    const recorded = toMarkdown({
      origin: 'http://localhost:3000',
      createdAt: 0,
      pages: [{
        path: '/settings', url: 'http://localhost:3000/settings', viewportFile: null,
        pins: [{
          pin: {
            ...pin('a', '/settings', 'x'),
            inspection: {
              ...inspection,
              console: [{ offsetMs: -2000, message: 'boom' }],
              network: [
                { offsetMs: -2000, method: 'POST', url: 'http://localhost:3000/api/save', status: 500, durationMs: 120 },
                { offsetMs: -3200, method: 'GET', url: 'http://localhost:3000/slow', status: null, durationMs: 3200 },
              ],
            },
          },
          cropFile: null,
        }],
      }],
    })
    expect(recorded).toContain(
      '- Console errors in the 30 s before the pin:\n  - 2.0 s before: `boom`\n' +
      '- Failed or slow requests in the 30 s before the pin:\n' +
      '  - 2.0 s before: POST `http://localhost:3000/api/save` 500 in 120 ms\n' +
      '  - 3.2 s before: GET `http://localhost:3000/slow` failed in 3200 ms\n',
    )
    expect(md).not.toContain('Console errors')
    expect(md).not.toContain('Failed or slow requests')
  })

  it('lists queries and interaction state only when present', () => {
    const withState = toMarkdown({
      origin: 'http://localhost:3000',
      createdAt: 0,
      pages: [{
        path: '/settings', url: 'http://localhost:3000/settings', viewportFile: null,
        pins: [{
          pin: {
            ...pin('a', '/settings', 'x'),
            inspection: {
              ...inspection,
              queries: [
                { key: '["user",7]', status: 'success', fetchStatus: 'idle', dataUpdatedAt: new Date(2026, 9, 26, 14, 1).getTime(), error: null, dataShape: 'object{id,name}' },
                { key: '["todos"]', status: 'error', fetchStatus: 'idle', dataUpdatedAt: 0, error: 'Network down', dataShape: 'undefined' },
              ],
              interaction: {
                focused: '#email',
                hovered: 'button',
                dialogs: ['#confirm', '#more'],
                searchParams: [{ key: 'tab', value: 'stock' }, { key: 'page', value: '2' }],
              },
            },
          },
          cropFile: null,
        }],
      }],
    })
    expect(withState).toContain(
      '- Queries:\n' +
      '  - `["user",7]`: success, idle, updated 2026-10-26 14:01, data object{id,name}\n' +
      '  - `["todos"]`: error, idle, never updated, data undefined, error `Network down`\n' +
      '- Focused: `#email`\n' +
      '- Hovered: `button`\n' +
      '- Open dialogs: `#confirm`, `#more`\n' +
      '- Search params: tab=stock, page=2\n',
    )
    const empty = toMarkdown({
      origin: 'http://localhost:3000',
      createdAt: 0,
      pages: [{
        path: '/settings', url: 'http://localhost:3000/settings', viewportFile: null,
        pins: [{
          pin: { ...pin('a', '/settings', 'x'), inspection: { ...inspection, queries: [], interaction: { focused: null, hovered: null, dialogs: [], searchParams: [] } } },
          cropFile: null,
        }],
      }],
    })
    for (const text of [md, empty]) {
      expect(text).not.toContain('Queries')
      expect(text).not.toContain('Focused')
      expect(text).not.toContain('Hovered')
      expect(text).not.toContain('Open dialogs')
      expect(text).not.toContain('Search params')
    }
  })

  it('lists the locator, classes and token matches next to the selector, only when present', () => {
    const render = (extra: Partial<Inspection>) => toMarkdown({
      origin: 'http://localhost:3000',
      createdAt: 0,
      pages: [{
        path: '/settings', url: 'http://localhost:3000/settings', viewportFile: null,
        pins: [{ pin: { ...pin('a', '/settings', 'x'), inspection: { ...inspection, ...extra } }, cropFile: null }],
      }],
    })
    const withTokens = render({
      locator: "getByRole('button', { name: 'Save' })",
      tokens: {
        classes: ['bg-background', 'p-4'],
        values: [
          { prop: 'background-color', value: 'rgb(255, 255, 255)', token: 'var(--background)' },
          { prop: 'color', value: 'rgb(9, 9, 9)', token: null },
        ],
      },
    })
    expect(withTokens).toContain(
      '- Selector: `form > button[type="submit"]`\n' +
      "- Locator: `getByRole('button', { name: 'Save' })`\n" +
      '- Classes: `bg-background p-4`\n' +
      '- Tokens: background-color: rgb(255, 255, 255) = var(--background); color: rgb(9, 9, 9) (no token)\n',
    )
    const withA11y = render({
      a11y: {
        role: 'button',
        name: 'Save',
        states: ['disabled'],
        violations: [{ id: 'color-contrast', impact: 'serious', selector: 'form > button' }],
      },
    })
    expect(withA11y).toContain(
      '- Accessibility: role `button`, name `Save`, states `disabled`\n' +
      '- Axe violations: `color-contrast` (serious) at `form > button`\n',
    )
    const bare = render({ a11y: { role: null, name: '', states: [], violations: [] } })
    expect(bare).toContain('- Accessibility: no role, no name\n')
    expect(bare).not.toContain('Axe violations')
    for (const text of [md, render({ locator: null, tokens: { classes: [], values: [] } })]) {
      expect(text).not.toContain('Accessibility')
      expect(text).not.toContain('Locator')
      expect(text).not.toContain('Classes')
      expect(text).not.toContain('Tokens')
    }
  })

  it('has no em dashes', () => {
    expect(md).not.toContain('—')
  })
})

describe('toMarkdown call sites', () => {
  const owners = [
    { name: 'MenuContent', env: 'client', stack: 'x', props: null, state: null },
    { name: 'UserMenu', env: 'client', stack: 'x', props: null, state: null },
    { name: 'X', env: 'client', stack: 'x', props: null, state: null },
  ] as const

  function render(elementFile: string) {
    const base = pin('c', '/menu', 'menu')
    return toMarkdown({
      origin: 'http://localhost:3000',
      createdAt: 0,
      pages: [{
        path: '/menu',
        url: 'http://localhost:3000/menu',
        viewportFile: null,
        pins: [{
          cropFile: null,
          pin: {
            ...base,
            inspection: { ...inspection, react: { elementStack: 'x', owners } },
            elementSite: { file: elementFile, line: 4, column: 2 },
            callSites: [
              { name: 'MenuContent', loc: { file: '/app/node_modules/@radix-ui/react-menu/dist/index.mjs', line: 9, column: 1 } },
              { name: 'UserMenu', loc: { file: '/app/src/user-menu.tsx', line: 22, column: 5 } },
              { name: 'X', loc: null },
            ],
          },
        }],
      }],
    })
  }

  it('prints a library call site by package and app sites by position', () => {
    const md = render('/app/src/button.tsx')
    expect(md).toContain('  - `<MenuContent>` in @radix-ui/react-menu\n')
    expect(md).toContain('  - `<UserMenu>` at /app/src/user-menu.tsx:22:5')
    expect(md).toContain('  - `<X>` at unresolved')
  })

  it('prints a library element site on the Source line by package', () => {
    const md = render('/app/node_modules/.pnpm/next@16.3.4_x/node_modules/next/dist/rsc.js')
    expect(md).toContain('- Source: library code in next (`<button>` element)')
  })
})

describe('toMarkdown detail levels', () => {
  const batch = (count: number) => ({
    origin: 'http://localhost:3000',
    createdAt: new Date(2026, 9, 26, 14, 2).getTime(),
    pages: [
      {
        path: '/inventory/new',
        url: 'http://localhost:3000/inventory/new',
        viewportFile: '/dl/vp1.png',
        pins: Array.from({ length: count }, (_, i) => ({
          pin: pin(`p${i}`, '/inventory/new', `note ${i}\nsecond line ${i}`),
          cropFile: `/dl/${i}.png`,
        })),
      },
    ],
  })

  it('renders no level exactly as standard', () => {
    expect(toMarkdown(batch(2))).toBe(toMarkdown({ ...batch(2), level: 'standard' }))
  })

  it('prints one line per pin in compact and nothing else per pin', () => {
    const md = toMarkdown({ ...batch(2), level: 'compact' })
    expect(md).toContain('1. **form > button[type="submit"]** (/app/components/ui/button.tsx:58): note 0\n')
    expect(md).toContain('2. **form > button[type="submit"]** (/app/components/ui/button.tsx:58): note 1\n')
    for (const absent of ['- Styles:', '- Attributes:', '- Parents', '- HTML', '- Screenshot', 'second line', '````']) {
      expect(md).not.toContain(absent)
    }
  })

  describe('selected text', () => {
    const withSelection = (level?: DetailLevel) => {
      const base = batch(1)
      const [{ pin: first }] = firstPage(base).pins
      const selected = { ...first, inspection: { ...first.inspection, selectedText: 'Save changes' } }
      return toMarkdown({ ...base, level, pages: [{ ...firstPage(base), pins: [{ pin: selected, cropFile: null }] }] })
    }

    it('prints the selected text in standard', () => {
      expect(withSelection()).toContain('- Selected text: "Save changes"\n')
    })

    it('prints the selected text right after the pin line in compact', () => {
      expect(withSelection('compact')).toContain('(/app/components/ui/button.tsx:58): note 0\nSelected text: "Save changes"\n')
    })

    it('prints nothing when the pin has no selected text', () => {
      expect(toMarkdown(batch(1))).not.toContain('Selected text')
      expect(toMarkdown({ ...batch(1), level: 'compact' })).not.toContain('Selected text')
    })
  })

  it('prints "no source" in compact when the element has no source', () => {
    const [{ pin: first }] = firstPage(batch(1)).pins
    const md = toMarkdown({
      ...batch(1),
      level: 'compact',
      pages: [{ ...firstPage(batch(1)), pins: [{ pin: { ...first, elementSite: null }, cropFile: null }] }],
    })
    expect(md).toContain('1. **form > button[type="submit"]** (no source): note 0\n')
  })

  it('keeps compact at or under a fifth of standard on 10 pins', () => {
    const standard = toMarkdown(batch(10)).length
    const compact = toMarkdown({ ...batch(10), level: 'compact' }).length
    console.log(`compact/standard on 10 pins: ${compact}/${standard} = ${(compact / standard).toFixed(3)}`)
    expect(compact * 5).toBeLessThanOrEqual(standard)
  })

  it('prints an Environment block per page in forensic, and none in standard', () => {
    const withAgent = pin('a', '/inventory/new', 'x')
    const stamped = {
      ...withAgent,
      createdAt: new Date(2026, 9, 26, 14, 5).getTime(),
      inspection: { ...inspection, viewport: { width: 1440, height: 900, dpr: 2, userAgent: 'Mozilla/5.0 Test' } },
    }
    const input = { ...batch(1), pages: [{ ...firstPage(batch(1)), pins: [{ pin: stamped, cropFile: null }] }] }
    const md = toMarkdown({ ...input, level: 'forensic' })
    expect(md).toContain('- Environment:\n  - Viewport: 1440x900\n  - DPR: 2\n  - User agent: Mozilla/5.0 Test\n  - URL: http://localhost:3000/inventory/new\n  - Captured: 2026-10-26 14:05\n')
    expect(md).toContain('- Styles:')
    expect(toMarkdown(input)).not.toContain('Environment')
  })

  it('says the user agent is unknown when capture did not record one', () => {
    expect(toMarkdown({ ...batch(1), level: 'forensic' })).toContain('  - User agent: unknown\n')
  })

  it('does not mention screenshots in the compact intro', () => {
    expect(toMarkdown({ ...batch(1), level: 'compact' })).not.toContain('Screenshots')
  })

  it('prints no Environment block for a page without pins', () => {
    const empty = { ...batch(1), pages: [{ ...firstPage(batch(1)), pins: [] }] }
    expect(toMarkdown({ ...empty, level: 'forensic' })).not.toContain('Environment')
  })

  it('has no em dashes at any level', () => {
    for (const level of ['compact', 'standard', 'forensic'] as const) {
      expect(toMarkdown({ ...batch(2), level })).not.toContain('—')
    }
  })
})

describe('toMarkdown box model and default styles', () => {
  const single = (ins: Inspection, level?: 'compact' | 'standard' | 'forensic') => toMarkdown({
    origin: 'http://localhost:3000',
    createdAt: 0,
    level,
    pages: [{ path: '/p', url: 'http://localhost:3000/p', viewportFile: null, pins: [{ pin: { ...pin('a', '/p', 'n'), inspection: ins }, cropFile: null }] }],
  })

  it('prints margin, padding and border per side on one Box model line, with no shorthand in Styles', () => {
    const md = single({
      ...inspection,
      styles: { display: 'flex', margin: '0px 8px', padding: '4px 12px', border: '1px solid red', color: 'red' },
      boxModel: { margin: [0, 8, 0, 8], padding: [4, 12, 4, 12], border: [1, 1, 1, 1] },
    })
    expect(md).toContain('- Box model: margin 0 8 0 8, padding 4 12 4 12, border 1 1 1 1\n')
    expect(md).toContain('- Styles: display: flex; border: 1px solid red; color: red\n')
  })

  it('prints no Box model line and keeps the shorthand for a pin captured without one', () => {
    const md = single({ ...inspection, styles: { display: 'flex', padding: '4px 12px' } })
    expect(md).not.toContain('Box model')
    expect(md).toContain('- Styles: display: flex; padding: 4px 12px\n')
  })

  it('drops gap on a parent that is neither flex nor grid', () => {
    expect(single({ ...inspection, ancestors: [{ selector: 'div.p', styles: { display: 'block', gap: '8px' } }] })).toContain('  - `div.p`: display: block\n')
  })

  const defaults = {
    position: 'static', opacity: '1', visibility: 'visible', 'z-index': 'auto', 'background-color': 'transparent',
    'box-shadow': 'none', 'border-radius': '0px', overflow: 'visible', gap: 'normal', 'pointer-events': 'auto', cursor: 'auto',
  }

  for (const [prop, value] of Object.entries(defaults)) {
    it(`drops ${prop}: ${value}`, () => {
      const md = single({ ...inspection, styles: { display: 'block', [prop]: value } })
      expect(md).toContain('- Styles: display: block\n')
    })
  }

  it('drops a zero-width none border whatever its colour, on the pin and on a parent', () => {
    expect(single({ ...inspection, styles: { display: 'block', border: '0px none rgb(0, 0, 0)' } })).toContain('- Styles: display: block\n')
    expect(parent({ display: 'block', border: '0px none rgb(255, 0, 0)' })).toContain('  - `div.p`: display: block\n')
  })

  it('drops a zero-width border whatever its style and colour, on the pin and on a parent', () => {
    const tailwind = '0px solid rgb(233, 233, 233)'
    expect(single({ ...inspection, styles: { display: 'block', border: tailwind } })).toContain('- Styles: display: block\n')
    expect(parent({ display: 'block', border: tailwind })).toContain('  - `div.p`: display: block\n')
  })

  it('drops the normal alignment defaults and the flex keys of a block heading', () => {
    const heading = {
      'align-items': 'normal', border: '0px solid rgb(233, 233, 233)', color: 'rgb(24, 24, 24)', display: 'block', 'flex-direction': 'row',
      'font-size': '18px', 'justify-content': 'normal', 'text-align': 'center',
    }
    expect(single({ ...inspection, styles: heading })).toContain('- Styles: color: rgb(24, 24, 24); display: block; font-size: 18px; text-align: center\n')
  })

  it('keeps the flex keys of a flex container and drops normal values', () => {
    const flex = { display: 'flex', 'flex-direction': 'row', 'justify-content': 'center', 'align-items': 'normal' }
    expect(single({ ...inspection, styles: flex })).toContain('- Styles: display: flex; flex-direction: row; justify-content: center\n')
  })

  it('drops grid keys on a pin that is not a grid and keeps them on one that is', () => {
    const keys = { 'grid-template-columns': '1fr 1fr' }
    expect(single({ ...inspection, styles: { display: 'block', ...keys } })).toContain('- Styles: display: block\n')
    expect(single({ ...inspection, styles: { display: 'grid', ...keys } })).toContain('- Styles: display: grid; grid-template-columns: 1fr 1fr\n')
  })

  it('keeps alignment keys on grid containers but not flex-direction', () => {
    const keys = { 'flex-direction': 'column', 'align-items': 'center', 'justify-content': 'space-between' }
    const expected = 'display: grid; align-items: center; justify-content: space-between'
    expect(single({ ...inspection, styles: { display: 'grid', ...keys } })).toContain(`- Styles: ${expected}\n`)
    expect(single({ ...inspection, ancestors: [{ selector: 'div.p', styles: { display: 'inline-grid', ...keys } }] })).toContain('  - `div.p`: display: inline-grid; align-items: center; justify-content: space-between\n')
  })

  it('keeps a real border', () => {
    expect(single({ ...inspection, styles: { display: 'block', border: '2px dashed rgb(255, 0, 0)' } })).toContain('- Styles: display: block; border: 2px dashed rgb(255, 0, 0)\n')
  })

  it('drops a fully transparent rgba background and keeps non-default values', () => {
    const md = single({ ...inspection, styles: { 'background-color': 'rgba(0, 0, 0, 0)', position: 'absolute', opacity: '0.5', cursor: 'pointer' } })
    expect(md).toContain('- Styles: position: absolute; opacity: 0.5; cursor: pointer\n')
  })

  it('omits the Styles line when every style is a default', () => {
    expect(single({ ...inspection, styles: { position: 'static', opacity: '1' } })).not.toContain('- Styles:')
  })

  const parent = (styles: Record<string, string>) => single({ ...inspection, ancestors: [{ selector: 'div.p', styles }] })

  it('prints flex keys for flex and inline-flex parents only', () => {
    const keys = { 'flex-direction': 'column', 'justify-content': 'center', 'align-items': 'center', 'grid-template-columns': '1fr 1fr' }
    expect(parent({ display: 'flex', ...keys })).toContain('  - `div.p`: display: flex; flex-direction: column; justify-content: center; align-items: center\n')
    expect(parent({ display: 'inline-flex', ...keys })).toContain('display: inline-flex; flex-direction: column')
    expect(parent({ display: 'block', ...keys })).toContain('  - `div.p`: display: block\n')
  })

  it('prints grid keys for grid and inline-grid parents only', () => {
    const keys = { 'flex-direction': 'row', 'grid-template-columns': '1fr 1fr', gap: '8px' }
    expect(parent({ display: 'grid', ...keys })).toContain('  - `div.p`: display: grid; grid-template-columns: 1fr 1fr; gap: 8px\n')
    expect(parent({ display: 'inline-grid', ...keys })).toContain('display: inline-grid; grid-template-columns: 1fr 1fr')
    expect(parent({ display: 'block', ...keys })).toContain('  - `div.p`: display: block\n')
  })

  it('drops default values on a parent', () => {
    expect(parent({ display: 'block', position: 'static', overflow: 'visible', width: '300px' })).toContain('  - `div.p`: display: block; width: 300px\n')
  })

  it('is not longer for the single-pin fixture than the previous format', () => {
    const raw = {
      display: 'inline-flex', position: 'static', width: '96px', height: '36px', margin: '0px 8px', padding: '4px 12px', color: 'rgb(255, 255, 255)',
      'background-color': 'rgba(0, 0, 0, 0)', border: '1px solid rgb(0, 0, 0)', 'border-radius': '0px', 'box-shadow': 'none', opacity: '1',
      visibility: 'visible', 'z-index': 'auto', overflow: 'visible', cursor: 'auto', 'pointer-events': 'auto', gap: 'normal',
    }
    const md = single({
      ...inspection,
      styles: raw,
      boxModel: { margin: [0, 8, 0, 8], padding: [4, 12, 4, 12], border: [1, 1, 1, 1] },
      ancestors: [{ selector: 'form.grid', styles: { display: 'block', position: 'static', 'flex-direction': 'row', 'justify-content': 'normal', 'align-items': 'normal', gap: 'normal', 'grid-template-columns': 'none', overflow: 'visible' } }],
    })
    const BEFORE = 1591
    console.log(`single-pin standard export length: before ${BEFORE}, after ${md.length}`)
    expect(md.length).toBeLessThanOrEqual(BEFORE)
  })
})
