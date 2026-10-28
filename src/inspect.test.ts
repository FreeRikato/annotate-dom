// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectElement, axeViolations } from './inspect'

const runInPage: typeof inspectElement = new Function(`return ${inspectElement.toString()}`)()
const runAxeInPage: typeof axeViolations = new Function(`return ${axeViolations.toString()}`)()

function itemForm() {
  const setter = { lastRenderedReducer: () => null }
  return {
    tag: 0,
    type: function ItemForm() {},
    _debugStack: { stack: 'Error\n    at InventoryPage (http://localhost:3000/c.js:5:9)' },
    _debugOwner: { name: 'InventoryPage', env: 'Server', props: { params: {} }, debugStack: { stack: 'server stack' } },
    memoizedProps: {
      mode: 'edit',
      apiKey: 'sk-live-123',
      authToken: 'abc',
      item: { id: 7, slab: { deep: { deeper: 1 } } },
      rows: [1, 2, 3, 4, 5, 6, 7],
      onSave: function onSave() {},
      notes: 'x'.repeat(250),
    },
    memoizedState: {
      memoizedState: 'draft',
      queue: setter,
      next: { memoizedState: { current: 1 }, queue: null, next: { memoizedState: true, queue: setter, next: null } },
    },
  }
}

describe('inspectElement', () => {
  it('collects DOM, React owners, redacted props and hook state', () => {
    document.body.innerHTML = `
      <main style="display:flex">
        <form data-slot="form">
          <button type="submit" class="btn primary" data-annotate-dom-target="m1" disabled>Save</button>
        </form>
      </main>`
    const button = document.querySelector('button')
    if (!button) throw new Error('fixture missing')
    Reflect.set(button, '__reactFiber$abc', {
      tag: 5,
      type: 'button',
      _debugStack: { stack: 'Error\n    at ItemForm (http://localhost:3000/c.js:1:2)' },
      _debugOwner: itemForm(),
    })

    const result = runInPage('m1')
    if (!result) throw new Error('no result')

    expect(result.tag).toBe('button')
    expect(result.html).toBe('<button type="submit" class="btn primary" disabled="">Save</button>')
    expect(document.querySelectorAll(result.selector)).toHaveLength(1)
    expect(result.attributes).toMatchObject({ type: 'submit', class: 'btn primary', '(disabled)': 'true' })
    expect(result.attributes).not.toHaveProperty('data-annotate-dom-target')
    expect(result.ancestors.map(a => a.selector)).toEqual(['form', 'main'])
    expect(result.ancestors[1].styles.display).toBe('flex')

    const owners = result.react?.owners ?? []
    expect(owners.map(o => [o.name, o.env])).toEqual([['ItemForm', 'client'], ['InventoryPage', 'server']])
    expect(result.react?.elementStack).toContain('at ItemForm')

    const props = JSON.parse(owners[0].props ?? 'null')
    expect(props.apiKey).toBe('[redacted]')
    expect(props.authToken).toBe('[redacted]')
    expect(props.mode).toBe('edit')
    expect(props.item).toEqual({ id: 7, slab: '[Object]' })
    expect(props.rows).toEqual([1, 2, 3, 4, 5, '...(+2 more)'])
    expect(props.onSave).toBe('[function onSave]')
    expect(props.notes).toMatch(/^x{200}\.\.\.\(\+50 chars\)$/)
    expect(JSON.parse(owners[0].state ?? 'null')).toEqual(['[string]', true])
    expect(JSON.parse(owners[1].props ?? 'null')).toEqual({ params: {} })
  })

  it('collects up to 20 owners nearest first, each with props', () => {
    document.body.innerHTML = '<button data-annotate-dom-target="m3">Go</button>'
    const button = document.querySelector('button')
    if (!button) throw new Error('fixture missing')
    let owner: object | undefined
    for (let n = 25; n >= 1; n--) {
      owner = { tag: 0, type: { displayName: `Owner${n}` }, memoizedProps: { n }, memoizedState: null, _debugOwner: owner }
    }
    Reflect.set(button, '__reactFiber$abc', { tag: 5, type: 'button', _debugOwner: owner })

    const owners = runInPage('m3')?.react?.owners ?? []
    expect(owners.map(o => o.name)).toEqual(Array.from({ length: 20 }, (_, i) => `Owner${i + 1}`))
    expect(owners.map(o => JSON.parse(o.props ?? 'null').n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  })

  function behindFourLibraryOwners(marker: string, hookValues: readonly unknown[]) {
    const button = document.querySelector('button')
    if (!button) throw new Error('fixture missing')
    const setter = { lastRenderedReducer: () => null }
    const hooks = hookValues.reduceRight<object | null>((next, memoizedState) => ({ memoizedState, queue: setter, next }), null)
    let owner: object = { tag: 0, type: { displayName: 'LoginDialog' }, memoizedProps: { title: 'Sign in' }, memoizedState: hooks }
    for (let n = 4; n >= 1; n--) owner = { tag: 0, type: { displayName: `Lib${n}` }, memoizedProps: {}, memoizedState: null, _debugOwner: owner }
    Reflect.set(button, '__reactFiber$abc', { tag: 5, type: 'button', _debugOwner: owner })
    const loginDialog = runInPage(marker)?.react?.owners[4]
    expect(loginDialog?.name).toBe('LoginDialog')
    return JSON.parse(loginDialog?.state ?? 'null')
  }

  it('hides every string held directly in hook state, whatever it looks like', () => {
    document.body.innerHTML = '<input type="password"><button data-annotate-dom-target="m4">Go</button>'
    const input = document.querySelector('input')
    if (!input) throw new Error('fixture missing')
    input.value = 'hunter2-password'
    const state = behindFourLibraryOwners('m4', [
      'hunter2-password',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
      'sk-live-abcdef0123456789',
      '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
    ])
    expect(state).toEqual(['[string]', '[string]', '[string]', '[string]', '[string]'])
  })

  it('hides a typed password in hook state after show-password turns the field to type=text', () => {
    document.body.innerHTML = '<input type="text"><button data-annotate-dom-target="m5">Go</button>'
    const input = document.querySelector('input')
    if (!input) throw new Error('fixture missing')
    input.value = 'hunter2-password'
    expect(behindFourLibraryOwners('m5', ['hunter2-password'])).toEqual(['[string]'])
  })

  it('hides a password kept in hook state after its field was cleared', () => {
    document.body.innerHTML = '<input type="password"><button data-annotate-dom-target="m6">Go</button>'
    expect(behindFourLibraryOwners('m6', ['hunter2-password'])).toEqual(['[string]'])
  })

  it('keeps numbers, booleans and shapes in hook state, hiding strings inside arrays but not under keys', () => {
    document.body.innerHTML = '<button data-annotate-dom-target="m7">Go</button>'
    expect(behindFourLibraryOwners('m7', [3, false, null, ['a', 2], { step: 'review', count: 2 }])).toEqual([
      3,
      false,
      null,
      ['[string]', 2],
      { step: 'review', count: 2 },
    ])
  })

  it('returns null when the marker is gone and works without React', () => {
    document.body.innerHTML = '<p data-annotate-dom-target="m2">plain</p>'
    expect(runInPage('missing')).toBeNull()
    expect(runInPage('m2')?.react).toBeNull()
  })

  describe('query cache', () => {
    function query(queryKey: unknown[], state: Record<string, unknown>) {
      return { queryKey, state: { status: 'success', fetchStatus: 'idle', dataUpdatedAt: 1_700_000_000_000, error: null, ...state } }
    }

    function pageWithClient(queries: unknown[]) {
      document.body.innerHTML = '<button data-annotate-dom-target="q1">Save</button>'
      const button = document.querySelector('button')
      if (!button) throw new Error('fixture missing')
      const client = { getQueryCache: () => ({ getAll: () => queries }) }
      const provider = { tag: 10, type: 'QueryClientProvider', memoizedProps: { value: client }, return: null }
      Reflect.set(button, '__reactFiber$abc', { tag: 5, type: 'button', return: { tag: 0, type: 'Page', return: provider } })
    }

    it('lists key, status, fetch status, update time, error and data shape for each query', () => {
      pageWithClient([
        query(['users'], { data: [] }),
        query(['user', 7], { data: { id: 7, name: 'Ada' } }),
        query(['todos'], { status: 'error', fetchStatus: 'idle', error: new Error('Network down'), data: undefined }),
        query(['count'], { data: 3 }),
        query(['maybe'], { data: null }),
      ])
      expect(runInPage('q1')?.queries).toEqual([
        { key: '["users"]', status: 'success', fetchStatus: 'idle', dataUpdatedAt: 1_700_000_000_000, error: null, dataShape: 'array(0)' },
        { key: '["user",7]', status: 'success', fetchStatus: 'idle', dataUpdatedAt: 1_700_000_000_000, error: null, dataShape: 'object{id,name}' },
        { key: '["todos"]', status: 'error', fetchStatus: 'idle', dataUpdatedAt: 1_700_000_000_000, error: 'Network down', dataShape: 'undefined' },
        { key: '["count"]', status: 'success', fetchStatus: 'idle', dataUpdatedAt: 1_700_000_000_000, error: null, dataShape: 'number' },
        { key: '["maybe"]', status: 'success', fetchStatus: 'idle', dataUpdatedAt: 1_700_000_000_000, error: null, dataShape: 'null' },
      ])
    })

    it('never puts a data value in the result', () => {
      pageWithClient([query(['me'], { data: { email: 'a@b.c' } }), query(['list'], { data: ['x@y.z'] })])
      const result = runInPage('q1')
      expect(JSON.stringify(result)).not.toContain('a@b.c')
      expect(JSON.stringify(result)).not.toContain('x@y.z')
      expect(result?.queries?.map(q => q.dataShape)).toEqual(['object{email}', 'array(1)'])
    })

    it('keeps at most 20 queries and 300 characters of an error message', () => {
      pageWithClient(Array.from({ length: 25 }, (_, i) => query(['q', i], { error: new Error('e'.repeat(400)) })))
      const result = runInPage('q1')
      expect(result?.queries).toHaveLength(20)
      expect(result?.queries?.[0].error).toBe('e'.repeat(300))
    })

    it('names at most 10 keys of an object shape', () => {
      const wide = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]))
      pageWithClient([query(['wide'], { data: wide })])
      expect(runInPage('q1')?.queries?.[0].dataShape).toBe('object{k0,k1,k2,k3,k4,k5,k6,k7,k8,k9,...}')
    })

    it('redacts secret-looking names inside a key', () => {
      pageWithClient([query(['session', { token: 'abc', page: 2 }], {})])
      expect(runInPage('q1')?.queries?.[0].key).toBe('["session",{"token":"[redacted]","page":2}]')
    })

    it('is empty without a QueryClientProvider above the element or without React', () => {
      document.body.innerHTML = '<p data-annotate-dom-target="q2">x</p><p data-annotate-dom-target="q3">y</p>'
      const [withFiber] = Array.from(document.querySelectorAll('p'))
      Reflect.set(withFiber, '__reactFiber$abc', { tag: 5, type: 'p', memoizedProps: { value: { other: 1 } }, return: null })
      expect(runInPage('q2')?.queries).toEqual([])
      expect(runInPage('q3')?.queries).toEqual([])
    })
  })

  describe('interaction state', () => {
    afterEach(() => {
      vi.restoreAllMocks()
      history.replaceState(null, '', '/')
    })

    it('lists the focused element, the hovered element, open dialogs and search params', () => {
      document.body.innerHTML = `
        <input id="email" />
        <button data-annotate-dom-target="i1">Save</button>
        <div role="dialog" id="confirm"></div>
        <dialog open id="native"></dialog>
        <details open id="more"></details>
        <dialog id="closed"></dialog>`
      document.querySelector<HTMLInputElement>('#email')?.focus()
      const button = document.querySelector('button')
      if (!button) throw new Error('fixture missing')
      const realQuery = document.querySelectorAll.bind(document)
      vi.spyOn(document, 'querySelectorAll').mockImplementation((selector: string) =>
        selector === ':hover' ? realQuery('button') : realQuery(selector))
      history.replaceState(null, '', '/inventory?tab=stock&page=2')

      expect(runInPage('i1')?.interaction).toEqual({
        focused: '#email',
        hovered: 'button',
        dialogs: ['#confirm', '#native', '#more'],
        searchParams: [{ key: 'tab', value: 'stock' }, { key: 'page', value: '2' }],
      })
    })

    it('never reports the overlay host as focused or hovered', () => {
      document.body.innerHTML = '<p data-annotate-dom-target="i5">x</p><annotate-dom-root></annotate-dom-root>'
      const host = document.querySelector('annotate-dom-root')
      if (!host) throw new Error('fixture missing')
      vi.spyOn(document, 'activeElement', 'get').mockReturnValue(host)
      const realQuery = document.querySelectorAll.bind(document)
      vi.spyOn(document, 'querySelectorAll').mockImplementation((selector: string) =>
        selector === ':hover' ? realQuery('body, annotate-dom-root') : realQuery(selector))
      expect(runInPage('i5')?.interaction).toMatchObject({ focused: null, hovered: null })
    })

    it('reports the elements the content script marked at pin time and keeps the marks out of the html', () => {
      document.body.innerHTML = `
        <annotate-dom-root></annotate-dom-root>
        <form data-annotate-dom-target="i6"><input id="email" data-annotate-dom-focused="" /><button data-annotate-dom-hovered="">Go</button></form>`
      const host = document.querySelector('annotate-dom-root')
      if (!host) throw new Error('fixture missing')
      vi.spyOn(document, 'activeElement', 'get').mockReturnValue(host)
      const inspection = runInPage('i6')
      expect(inspection?.interaction).toMatchObject({ focused: '#email', hovered: 'button' })
      expect(inspection?.html).not.toContain('data-annotate-dom')
    })

    it('leaves the pin-time marks out of the attributes of the pinned element itself', () => {
      document.body.innerHTML = '<input id="email" data-annotate-dom-target="i7" data-annotate-dom-focused="" />'
      const inspection = runInPage('i7')
      expect(Object.keys(inspection?.attributes ?? {})).toEqual(['id', '(value)', '(disabled)'])
      expect(inspection?.interaction?.focused).toBe('#email')
    })

    it('lists at most 5 open dialogs', () => {
      document.body.innerHTML = `<p data-annotate-dom-target="i4">x</p>${'<div role="dialog"></div>'.repeat(7)}`
      expect(runInPage('i4')?.interaction?.dialogs).toHaveLength(5)
    })

    it('is empty when nothing is focused, hovered or open', () => {
      document.body.innerHTML = '<p data-annotate-dom-target="i2">x</p>'
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      expect(runInPage('i2')?.interaction).toEqual({ focused: null, hovered: null, dialogs: [], searchParams: [] })
    })

    it('redacts the value of a secret-looking search param', () => {
      document.body.innerHTML = '<p data-annotate-dom-target="i3">x</p>'
      history.replaceState(null, '', '/?token=abc&tab=a')
      expect(runInPage('i3')?.interaction?.searchParams).toEqual([
        { key: 'token', value: '[redacted]' },
        { key: 'tab', value: 'a' },
      ])
    })
  })

  describe('page recorder', () => {
    afterEach(() => {
      Reflect.deleteProperty(window, '__annotateDomRecorder')
      vi.useRealTimers()
    })

    it('lists recorded events with offsets relative to the pin', () => {
      vi.useFakeTimers()
      vi.setSystemTime(100_000)
      document.body.innerHTML = '<p data-annotate-dom-target="m3">x</p>'
      Reflect.set(window, '__annotateDomRecorder', {
        read: () => ({
          console: [{ at: 98_000, message: 'boom' }],
          network: [{ at: 96_800, method: 'GET', url: 'http://localhost:3000/slow', status: 200, durationMs: 3200 }],
        }),
      })
      const result = runInPage('m3')
      expect(result?.console).toEqual([{ offsetMs: -2000, message: 'boom' }])
      expect(result?.network).toEqual([
        { offsetMs: -3200, method: 'GET', url: 'http://localhost:3000/slow', status: 200, durationMs: 3200 },
      ])
    })

    it('lists nothing when the recorder returns a malformed buffer', () => {
      document.body.innerHTML = '<p data-annotate-dom-target="m5">x</p>'
      Reflect.set(window, '__annotateDomRecorder', { read: () => ({ console: [{ at: 1, message: 'a' }] }) })
      const result = runInPage('m5')
      expect(result?.console).toEqual([])
      expect(result?.network).toEqual([])
    })

    it('drops single malformed entries and keeps the valid ones', () => {
      vi.setSystemTime(100_000)
      document.body.innerHTML = '<p data-annotate-dom-target="m6">x</p>'
      Reflect.set(window, '__annotateDomRecorder', {
        read: () => ({
          console: [{ at: 99_000, message: 'ok' }, { at: 'late', message: 'bad' }, null],
          network: [{ at: 99_000, method: 'GET', url: 'http://localhost:3000/a', status: null, durationMs: 5 }, { at: 99_000, method: 'GET' }, 'x'],
        }),
      })
      const result = runInPage('m6')
      expect(result?.console).toEqual([{ offsetMs: -1000, message: 'ok' }])
      expect(result?.network).toEqual([{ offsetMs: -1000, method: 'GET', url: 'http://localhost:3000/a', status: null, durationMs: 5 }])
    })

    it('lists nothing when the page has no recorder', () => {
      document.body.innerHTML = '<p data-annotate-dom-target="m4">x</p>'
      const result = runInPage('m4')
      expect(result?.console).toEqual([])
      expect(result?.network).toEqual([])
    })
  })
  describe('design tokens', () => {
    function pageWithTheme(body: string) {
      document.head.innerHTML = '<style>:root { --background: #ffffff; --space-4: 1rem; --foreground: rgb(10, 10, 10) }</style>'
      document.body.innerHTML = body
    }

    afterEach(() => {
      document.head.innerHTML = ''
    })

    it('lists the classes and matches computed values against :root custom properties', () => {
      pageWithTheme(`<div class="bg-background p-4" data-annotate-dom-target="t1"
        style="background-color: #ffffff; padding: 16px; color: rgb(9, 9, 9)">x</div>`)
      const tokens = runInPage('t1')?.tokens
      expect(tokens?.classes).toEqual(['bg-background', 'p-4'])
      expect(tokens?.values).toContainEqual({ prop: 'background-color', value: '#ffffff', token: 'var(--background)' })
      expect(tokens?.values).toContainEqual({ prop: 'padding', value: '16px', token: 'var(--space-4)' })
    })

    it('lists a value that no custom property equals with no match', () => {
      pageWithTheme('<div data-annotate-dom-target="t2" style="color: rgb(9, 9, 9)">x</div>')
      expect(runInPage('t2')?.tokens?.values).toContainEqual({ prop: 'color', value: 'rgb(9, 9, 9)', token: null })
    })

    it('does not match inherited text colour to a custom property that is not a colour', () => {
      document.head.innerHTML = '<style>:root { --radius: 0.5rem; --foreground: rgb(10, 10, 10) } body { color: rgb(10, 10, 10) }</style>'
      document.body.innerHTML = '<p data-annotate-dom-target="t8">plain</p>'
      const colour = runInPage('t8')?.tokens?.values.find(v => v.prop === 'color')
      expect(colour).toEqual({ prop: 'color', value: 'rgb(10, 10, 10)', token: 'var(--foreground)' })
    })

    it('ignores custom properties that are not set on :root', () => {
      document.head.innerHTML = '<style>.card { --card-bg: #ffffff }</style>'
      document.body.innerHTML = '<div class="card" data-annotate-dom-target="t5" style="background-color: #ffffff">x</div>'
      expect(runInPage('t5')?.tokens?.values).toEqual([{ prop: 'background-color', value: '#ffffff', token: null }])
    })

    it('finds custom properties inside grouping rules such as @media', () => {
      document.head.innerHTML = '<style>@media screen { :root { --brand: #ff0000 } }</style>'
      document.body.innerHTML = '<div data-annotate-dom-target="t7" style="color: #ff0000">x</div>'
      expect(runInPage('t7')?.tokens?.values).toEqual([{ prop: 'color', value: '#ff0000', token: 'var(--brand)' }])
    })

    it('leaves out unset and zero values', () => {
      pageWithTheme('<div data-annotate-dom-target="t3" style="margin: 0px">x</div>')
      expect(runInPage('t3')?.tokens?.values).toEqual([])
    })

    it('has no matches when the page defines no custom properties', () => {
      document.head.innerHTML = ''
      document.body.innerHTML = '<div class="a" data-annotate-dom-target="t4" style="padding: 16px">x</div>'
      expect(runInPage('t4')?.tokens).toEqual({ classes: ['a'], values: [{ prop: 'padding', value: '16px', token: null }] })
    })
  })

  describe('locator', () => {
    function locatorFor(body: string, marker: string) {
      document.body.innerHTML = body
      return runInPage(marker)?.locator
    }

    function target(marker: string) {
      return document.querySelector(`[data-annotate-dom-target="${marker}"]`)
    }

    it('names a button by role and accessible name, and that locator finds only it', () => {
      const locator = locatorFor(`
        <button>Save</button>
        <button data-annotate-dom-target="l1">Toggle dark mode</button>`, 'l1')
      expect(locator).toBe(`getByRole('button', { name: 'Toggle dark mode' })`)
      const found = Array.from(document.querySelectorAll('button')).filter(b => b.textContent === 'Toggle dark mode')
      expect(found).toEqual([target('l1')])
    })

    it('falls back to the label for a control with no role', () => {
      const locator = locatorFor(`
        <label for="email">Email</label>
        <input id="email" type="password" data-annotate-dom-target="l2" />
        <label>Name <input type="text" /></label>`, 'l2')
      expect(locator).toBe(`getByLabel('Email')`)
      const labelled = document.querySelector<HTMLLabelElement>('label[for]')?.control
      expect(labelled).toBe(target('l2'))
    })

    it('uses exact text when it is unique and no role or label applies', () => {
      const locator = locatorFor('<p>Total</p><p data-annotate-dom-target="l3">Total due</p>', 'l3')
      expect(locator).toBe(`getByText('Total due', { exact: true })`)
    })

    it('names the innermost element when a wrapper has the same text', () => {
      const locator = locatorFor('<div><span data-annotate-dom-target="l9">Total</span></div>', 'l9')
      expect(locator).toBe(`getByText('Total', { exact: true })`)
    })

    it('uses the test id when nothing else is unique', () => {
      const locator = locatorFor('<div data-testid="row-2"></div><div data-testid="row-3" data-annotate-dom-target="l4"></div>', 'l4')
      expect(locator).toBe(`getByTestId('row-3')`)
      expect(document.querySelectorAll('[data-testid="row-3"]')).toHaveLength(1)
    })

    it('skips a role locator that matches more than one element', () => {
      const locator = locatorFor(`
        <button>Delete</button>
        <button data-annotate-dom-target="l5" data-testid="del-2">Delete</button>`, 'l5')
      expect(locator).toBe(`getByTestId('del-2')`)
    })

    it('counts a longer name that contains the name as a second match', () => {
      const locator = locatorFor(`
        <button>Save all</button>
        <button data-annotate-dom-target="l6">Save</button>`, 'l6')
      expect(locator).toBe(`getByText('Save', { exact: true })`)
    })

    it('is null when no rule gives a unique match', () => {
      expect(locatorFor('<div></div><div data-annotate-dom-target="l7"></div>', 'l7')).toBeNull()
    })

    it('escapes quotes in the name', () => {
      const locator = locatorFor(`<button data-annotate-dom-target="l8">It's on</button>`, 'l8')
      expect(locator).toBe(`getByRole('button', { name: 'It\\'s on' })`)
    })
  })
  describe('accessibility', () => {
    function a11yOf(body: string, marker: string) {
      document.body.innerHTML = body
      return runInPage(marker)?.a11y
    }

    it('lists role, name and state, with no violations before axe runs', () => {
      const a11y = a11yOf('<button aria-disabled="true" data-annotate-dom-target="a1">Save</button>', 'a1')
      expect(a11y).toEqual({ role: 'button', name: 'Save', states: ['disabled'], violations: [] })
    })

    it('reads states from native and aria attributes', () => {
      const a11y = a11yOf(`
        <input type="checkbox" checked required data-annotate-dom-target="a2" aria-label="Agree" aria-expanded="false" />`, 'a2')
      expect(a11y).toEqual({ role: 'checkbox', name: 'Agree', states: ['checked', 'collapsed', 'required'], violations: [] })
    })

    it('has a null role and an empty name for a bare div', () => {
      expect(a11yOf('<div data-annotate-dom-target="a3"></div>', 'a3')).toEqual({ role: null, name: '', states: [], violations: [] })
    })

    it('does not put axe on the page when inspecting', () => {
      a11yOf('<button data-annotate-dom-target="a4">Go</button>', 'a4')
      expect(Reflect.get(window, 'axe')).toBeUndefined()
    })
  })

  describe('axeViolations', () => {
    afterEach(() => Reflect.deleteProperty(window, 'axe'))

    function fakeAxe(violations: unknown[]) {
      const run = vi.fn(async (_context: Element) => ({ violations }))
      Reflect.set(window, 'axe', { run })
      return run
    }

    it('runs axe on the pinned element only and maps each failing node', async () => {
      document.body.innerHTML = '<img src="a.png" /><div><img data-annotate-dom-target="v1" src="b.png" /></div>'
      const run = fakeAxe([
        { id: 'image-alt', impact: 'critical', nodes: [{ target: ['div > img'] }, { target: ['iframe', 'img'] }] },
        { id: 'region', impact: null, nodes: [{ target: ['body'] }] },
      ])
      const result = await runAxeInPage('v1')
      expect(run.mock.calls[0][0]).toBe(document.querySelector('[data-annotate-dom-target="v1"]'))
      expect(result).toEqual([
        { id: 'image-alt', impact: 'critical', selector: 'div > img' },
        { id: 'image-alt', impact: 'critical', selector: 'iframe img' },
        { id: 'region', impact: null, selector: 'body' },
      ])
    })

    it('is empty when axe is not on the page or the element is gone', async () => {
      document.body.innerHTML = '<p data-annotate-dom-target="v2">x</p>'
      expect(await runAxeInPage('v2')).toEqual([])
      fakeAxe([{ id: 'x', impact: 'minor', nodes: [{ target: ['p'] }] }])
      expect(await runAxeInPage('missing')).toEqual([])
    })

    it('finds a real violation inside the subtree and none outside it', async () => {
      Reflect.set(window, 'axe', (await import('axe-core')).default)
      document.body.innerHTML = '<img src="a.png" /><div><button data-annotate-dom-target="v3">Ok</button></div>'
      expect(await runAxeInPage('v3')).toEqual([])
      document.body.innerHTML = '<button>Ok</button><div><img data-annotate-dom-target="v4" src="b.png" /></div>'
      const found = await runAxeInPage('v4')
      expect(found.map(v => v.id)).toEqual(['image-alt'])
      expect(found[0].selector).toContain('img')
    })
  })
})
