// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectElement } from './inspect'

const runInPage: typeof inspectElement = new Function(`return ${inspectElement.toString()}`)()

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
    expect(JSON.parse(owners[0].state ?? 'null')).toEqual(['draft', true])
    expect(JSON.parse(owners[1].props ?? 'null')).toEqual({ params: {} })
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

    it('lists nothing when the page has no recorder', () => {
      document.body.innerHTML = '<p data-annotate-dom-target="m4">x</p>'
      const result = runInPage('m4')
      expect(result?.console).toEqual([])
      expect(result?.network).toEqual([])
    })
  })
})
