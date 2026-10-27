import { describe, expect, it } from 'vitest'
import { toMarkdown } from './markdown'
import type { Inspection, Pin } from './types'

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
    expect(md).toContain('  - `<InventoryPage>` (server component) at library code (next/dist/rsc.js:3524:35)')
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
