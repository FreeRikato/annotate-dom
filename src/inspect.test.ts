// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { chromium, type Browser } from '@playwright/test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { inspectElement, axeViolations } from './inspect'
import type { CssVariable } from './lib/types'

const runInPage: typeof inspectElement = new Function(`return ${inspectElement.toString()}`)()
const runAxeInPage: typeof axeViolations = new Function(`return ${axeViolations.toString()}`)()

function isStyleSheetList(value: unknown): value is StyleSheetList {
  return Array.isArray(value) && typeof Reflect.get(value, 'item') === 'function'
}

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
  it('records margin, padding and border width as four numbers each, top right bottom left', () => {
    document.body.innerHTML = '<div data-annotate-dom-target="bm1" style="margin: 0 8px; padding: 4px 12px; border: 1px solid red; border-left-width: 3px">x</div>'
    expect(runInPage('bm1')?.boxModel).toEqual({ margin: [0, 8, 0, 8], padding: [4, 12, 4, 12], border: [1, 1, 1, 3] })
  })

  describe('selected text', () => {
    function select(from: Node, fromOffset: number, to: Node, toOffset: number) {
      const range = document.createRange()
      range.setStart(from, fromOffset)
      range.setEnd(to, toOffset)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }

    function textOf(selector: string): Text {
      const node = document.querySelector(selector)?.firstChild
      if (!(node instanceof Text)) throw new Error('fixture missing')
      return node
    }

    it('keeps the trimmed text selected inside the element', () => {
      document.body.innerHTML = '<p id="a" data-annotate-dom-target="s1">say hello there</p>'
      const text = textOf('#a')
      select(text, 3, text, 12)
      expect(runInPage('s1')?.selectedText).toBe('hello th')
    })

    it('trims whitespace around the selection', () => {
      document.body.innerHTML = '<p id="a" data-annotate-dom-target="s1">say   hello   there</p>'
      const text = textOf('#a')
      select(text, 3, text, 12)
      expect(runInPage('s1')?.selectedText).toBe('hello')
    })

    it('keeps the selected text when the selection runs into the element from outside', () => {
      document.body.innerHTML = '<p id="a">before text</p><p id="b" data-annotate-dom-target="s1">inside text</p>'
      select(textOf('#a'), 7, textOf('#b'), 6)
      expect(runInPage('s1')?.selectedText).toContain('text')
      expect(runInPage('s1')?.selectedText).toContain('inside')
    })

    it('stores nothing when the selection is entirely outside the element', () => {
      document.body.innerHTML = '<p id="a">elsewhere</p><p id="b" data-annotate-dom-target="s1">pinned</p>'
      const text = textOf('#a')
      select(text, 0, text, 9)
      expect(runInPage('s1')?.selectedText).toBeUndefined()
    })

    it('stores nothing when the selection is only whitespace', () => {
      document.body.innerHTML = '<p id="a" data-annotate-dom-target="s1">say     there</p>'
      const text = textOf('#a')
      select(text, 4, text, 7)
      expect(runInPage('s1')?.selectedText).toBeUndefined()
    })

    it('stores nothing when nothing is selected', () => {
      document.body.innerHTML = '<p data-annotate-dom-target="s1">pinned</p>'
      window.getSelection()?.removeAllRanges()
      expect(runInPage('s1')?.selectedText).toBeUndefined()
    })

    it('cuts the text at 500 characters', () => {
      document.body.innerHTML = `<p id="a" data-annotate-dom-target="s1">${'x'.repeat(800)}</p>`
      const text = textOf('#a')
      select(text, 0, text, 800)
      expect(runInPage('s1')?.selectedText).toBe('x'.repeat(500))
    })

    it('does not throw for a selection inside an input', () => {
      document.body.innerHTML = '<input id="i" value="typed value" data-annotate-dom-target="s1">'
      const input = document.querySelector('input')
      if (!input) throw new Error('fixture missing')
      input.select()
      expect(() => runInPage('s1')).not.toThrow()
    })

    it('does not throw for a selection inside a shadow root', () => {
      document.body.innerHTML = '<div id="host" data-annotate-dom-target="s1"></div>'
      const host = document.querySelector('#host')
      const root = host?.attachShadow({ mode: 'open' })
      if (!root) throw new Error('fixture missing')
      root.innerHTML = '<span>shadow words</span>'
      const inner = root.firstChild?.firstChild
      if (!inner) throw new Error('fixture missing')
      select(inner, 0, inner, 6)
      expect(() => runInPage('s1')).not.toThrow()
    })

    it('leaves the page selection as it was', () => {
      document.body.innerHTML = '<p id="a" data-annotate-dom-target="s1">say hello there</p>'
      const text = textOf('#a')
      select(text, 3, text, 12)
      runInPage('s1')
      const selection = window.getSelection()
      expect(selection?.rangeCount).toBe(1)
      expect(selection?.toString()).toBe(' hello th')
      expect(selection?.anchorNode).toBe(text)
      expect(selection?.anchorOffset).toBe(3)
      expect(selection?.focusOffset).toBe(12)
    })
  })

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

  describe('secret redaction', () => {
    function reactProps(marker: string, props: object, state: unknown = null) {
      document.body.innerHTML = `<button data-annotate-dom-target="${marker}">Go</button>`
      const button = document.querySelector('button')
      if (!button) throw new Error('fixture missing')
      Reflect.set(button, '__reactFiber$abc', {
        tag: 5,
        type: 'button',
        _debugOwner: { tag: 0, type: { displayName: 'Form' }, memoizedProps: props, memoizedState: state },
      })
      const owner = runInPage(marker)?.react?.owners[0]
      return { props: JSON.parse(owner?.props ?? 'null'), state: owner?.state }
    }

    it('serializes Date, Map, Set and Promise values from another realm like the ones from this page', () => {
      const other = runInNewContext('({ when: new Date(0), map: new Map([[1, 2]]), set: new Set([1, 2, 3]), later: Promise.resolve(1), plain: { n: 1 } })')
      expect(other.when instanceof Date).toBe(false)
      expect(reactProps('r1', other).props).toEqual({ when: '1970-01-01T00:00:00.000Z', map: '[Map(1)]', set: '[Set(3)]', later: '[Promise]', plain: { n: 1 } })
    })

    it('exports an invalid Date, a Date from another realm and an object posing as a Date without throwing', () => {
      const posing = { [Symbol.toStringTag]: 'Date', toISOString: () => { throw new Error('page code ran') } }
      const props = reactProps('r1', {
        bad: new Date('x'),
        badOther: runInNewContext('new Date("x")'),
        posing,
        fine: runInNewContext('new Date(0)'),
      }).props
      expect(props).toEqual({ bad: '[Invalid Date]', badOther: '[Invalid Date]', posing: '[Date]', fine: '1970-01-01T00:00:00.000Z' })
    })

    it('exports an object whose toStringTag getter throws without throwing', () => {
      const hostile = { get [Symbol.toStringTag](): string { throw new Error('page code ran') }, n: 1 }
      expect(reactProps('r1', { hostile }).props).toEqual({ hostile: { n: 1 } })
    })

    it('turns a revoked proxy, a proxied Map and a throwing getter into [unreadable] for that value only', () => {
      const revoked = Proxy.revocable({}, {})
      revoked.revoke()
      const props = reactProps('r1', {
        revoked: revoked.proxy,
        map: new Proxy(new Map([[1, 2]]), {}),
        set: new Proxy(new Set([1]), {}),
        getter: { get boom(): string { throw new Error('page code ran') } },
        fine: 1,
      }).props
      expect(props).toEqual({ revoked: '[unreadable]', map: '[unreadable]', set: '[unreadable]', getter: '[unreadable]', fine: 1 })
    })

    it.each(['pwd', 'passcode', 'pin', 'otp', 'credential', 'token', 'secret', 'password', 'key', 'session', 'auth', 'cookie'])(
      'redacts the value under %s in any case',
      name => {
        const { props } = reactProps('r1', { [name]: 'hunter2', [name.toUpperCase()]: 'hunter2' })
        expect(props[name]).toBe('[redacted]')
        expect(props[name.toUpperCase()]).toBe('[redacted]')
      },
    )

    it.each(['userPwd', 'otpCode', 'billingCredentials', 'resetPasscode', 'confirmPin', 'pin', 'userPin', 'user_pin', 'user-pin', 'otp_code', 'OTP', 'OTPCode', 'PIN'])(
      'redacts the value under the longer key %s',
      name => {
        expect(reactProps('r2', { [name]: 'hunter2' }).props[name]).toBe('[redacted]')
      },
    )

    it.each(['shipping', 'spinner', 'isPinned', 'footprint', 'opinion', 'topping', 'mapping', 'typing', 'hotpot'])(
      'keeps the value under %s, which only contains pin or otp inside a word',
      name => {
        expect(reactProps('r2', { [name]: 'kept' }).props[name]).toBe('kept')
      },
    )

    it('keeps a search param whose key only contains pin inside a word', () => {
      document.body.innerHTML = '<p data-annotate-dom-target="r7">x</p>'
      history.replaceState(null, '', '/?shipping=a&userPin=1')
      expect(runInPage('r7')?.interaction?.searchParams).toEqual([
        { key: 'shipping', value: 'a' },
        { key: 'userPin', value: '[redacted]' },
      ])
    })

    it('redacts inside hook state objects and leaves other keys alone', () => {
      const { state } = reactProps('r3', {}, {
        memoizedState: { pwd: 'hunter2', name: 'ada' },
        queue: { lastRenderedReducer: () => null },
        next: null,
      })
      expect(state).toContain('[redacted]')
      expect(state).not.toContain('hunter2')
      expect(state).toContain('"name":"ada"')
    })

    it('redacts a JWT-shaped string value under an innocent key', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln'
      const { props } = reactProps('r4', { note: jwt, label: 'plain' })
      expect(props.note).toBe('[redacted]')
      expect(props.label).toBe('plain')
    })

    it('redacts the value attribute of a password input', () => {
      document.body.innerHTML = '<input type="password" value="hunter2" data-annotate-dom-target="r5">'
      const result = runInPage('r5')
      expect(result?.attributes['(value)']).toBe('[redacted]')
      expect(result?.attributes.value).toBe('[redacted]')
    })

    it('strips the value attribute of a password input from the exported html', () => {
      document.body.innerHTML = '<input type="password" value="hunter2" data-annotate-dom-target="r8">'
      const html = runInPage('r8')?.html
      expect(html).toContain('type="password"')
      expect(html).not.toContain('hunter2')
    })

    it('strips the password values of fields inside the pinned element', () => {
      document.body.innerHTML = '<form data-annotate-dom-target="r9"><input name="user" value="ada"><input type="password" value="hunter2"></form>'
      const html = runInPage('r9')?.html
      expect(html).toContain('value="ada"')
      expect(html).not.toContain('hunter2')
      expect(document.querySelector('input[type="password"]')?.getAttribute('value')).toBe('hunter2')
    })

    it('redacts the value of a pwd or otp search param', () => {
      document.body.innerHTML = '<p data-annotate-dom-target="r6">x</p>'
      history.replaceState(null, '', '/?pwd=a&otp=1&tab=b')
      expect(runInPage('r6')?.interaction?.searchParams).toEqual([
        { key: 'pwd', value: '[redacted]' },
        { key: 'otp', value: '[redacted]' },
        { key: 'tab', value: 'b' },
      ])
    })
  })

  it('records the user agent beside the viewport', () => {
    document.body.innerHTML = '<button data-annotate-dom-target="m1">Save</button>'
    expect(runInPage('m1')?.viewport.userAgent).toBe(navigator.userAgent)
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

  describe('css variables', () => {
    function variablesOf(head: string, body: string, marker = 'v1') {
      document.head.innerHTML = head
      document.body.innerHTML = body
      return runInPage(marker)?.cssVariables
    }

    beforeEach(() => {
      const realComputedStyle = window.getComputedStyle.bind(window)
      vi.spyOn(window, 'getComputedStyle').mockImplementation(node => {
        const own = realComputedStyle(node)
        return new Proxy(own, {
          get(target, key) {
            if (key !== 'getPropertyValue') return Reflect.get(target, key)
            return (name: string) => {
              for (let n: Element | null = node; n; n = n.parentElement) {
                const value = realComputedStyle(n).getPropertyValue(name)
                if (value !== '' || !name.startsWith('--')) return value
              }
              return ''
            }
          },
        })
      })
    })

    afterEach(() => {
      vi.restoreAllMocks()
      document.head.innerHTML = ''
    })

    it('lists a variable declared on the element by an inline style', () => {
      expect(variablesOf('', '<div data-annotate-dom-target="v1" style="--accent: #f00">x</div>')).toEqual([{ name: '--accent', value: '#f00' }])
    })

    it('lists a variable declared on an ancestor, with the value the element resolves', () => {
      const head = '<style>.theme { --primary: blue } .theme .inner { --primary: green }</style>'
      const body = '<div class="theme"><section class="inner"><button data-annotate-dom-target="v1">x</button></section></div>'
      expect(variablesOf(head, body)).toEqual([{ name: '--primary', value: 'green' }])
    })

    it('lists a variable declared by a rule on an ancestor other than the root', () => {
      const head = '<style>.panel { --gap: 8px }</style>'
      expect(variablesOf(head, '<section class="panel"><button data-annotate-dom-target="v1">x</button></section>')).toEqual([{ name: '--gap', value: '8px' }])
    })

    it('leaves out a variable declared only at the root unless something reads it', () => {
      expect(variablesOf('<style>:root { --radius: 0.5rem } html { --unused: 1 }</style>', '<button data-annotate-dom-target="v1">x</button>')).toEqual([])
    })

    it('lists a root variable that a matching rule reads through var()', () => {
      const head = '<style>:root { --space: 4px } .btn { padding: var(--space); color: var(--missing, red) }</style>'
      const names = variablesOf(head, '<button class="btn" data-annotate-dom-target="v1">x</button>')?.map(v => v.name)
      expect(names).toEqual(['--space'])
    })

    it('lists a variable that the element inline style reads through var()', () => {
      const head = '<style>:root { --ink: navy }</style>'
      const body = '<button data-annotate-dom-target="v1" style="color: var(--ink)">x</button>'
      expect(variablesOf(head, body)).toEqual([{ name: '--ink', value: 'navy' }])
    })

    it('follows a variable whose value reads another variable', () => {
      const head = '<style>:root { --base: 4px; --space: var(--base); --unrelated: 9px } .btn { padding: var(--space) }</style>'
      const names = variablesOf(head, '<button class="btn" data-annotate-dom-target="v1">x</button>')?.map(v => v.name)
      expect(names).toEqual(['--base', '--space'])
    })

    it('leaves out variables that only rules matching other elements declare or read', () => {
      const head = '<style>.other { --nope: 1; color: var(--also-nope) } #elsewhere { --aside: 2 } :root { --kept: 3 }</style>'
      const body = '<div id="elsewhere" class="other"></div><button data-annotate-dom-target="v1">x</button>'
      expect(variablesOf(head, body)).toEqual([])
    })

    it('finds variables inside grouping rules such as @media', () => {
      const head = '<style>@media screen { .card { --brand: #00f } }</style>'
      expect(variablesOf(head, '<i class="card" data-annotate-dom-target="v1">x</i>')).toEqual([{ name: '--brand', value: '#00f' }])
    })

    it('ignores a rule whose selector the browser cannot evaluate', () => {
      const matches = Element.prototype.matches
      vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
        if (selector === '.unsupported') throw new DOMException('not a valid selector', 'SyntaxError')
        return matches.call(this, selector)
      })
      const head = '<style>.unsupported { --bad: 1 } .ok { --good: 2 }</style>'
      expect(variablesOf(head, '<i class="ok unsupported" data-annotate-dom-target="v1">x</i>')?.map(v => v.name)).toEqual(['--good'])
    })

    it('puts the variables the element reads first, then the ones it declares, each sorted by name', () => {
      const head = '<style>:root { --zeta: 1; --alpha: 2 } .box { --beta: 3; --aaa: 4; color: var(--zeta); margin: var(--alpha) }</style>'
      expect(variablesOf(head, '<i class="box" data-annotate-dom-target="v1">x</i>')?.map(v => v.name)).toEqual(['--alpha', '--zeta', '--aaa', '--beta'])
    })

    it('drops a variable that a rule reads but nothing declares', () => {
      const head = '<style>:root { --set: 1 } .btn { color: var(--never-declared); margin: var(--set) }</style>'
      expect(variablesOf(head, '<i class="btn" data-annotate-dom-target="v1">x</i>')?.map(v => v.name)).toEqual(['--set'])
    })

    it('keeps the variables a Tailwind-like sheet reads among 200 root variables', () => {
      const root = Array.from({ length: 200 }, (_, i) => `--color-${String(i).padStart(3, '0')}: ${i}`).join('; ')
      const head = `<style>:root { ${root}; --primary: oklch(0.2 0 0); --radius: 0.5rem } .btn { background: var(--primary); border-radius: var(--radius) }</style>`
      const found = variablesOf(head, '<button class="btn" data-annotate-dom-target="v1">x</button>')
      expect(found).toEqual([
        { name: '--primary', value: 'oklch(0.2 0 0)' },
        { name: '--radius', value: '0.5rem' },
      ])
    })

    it('caps the list at 30 after the variables the element reads', () => {
      const declared = Array.from({ length: 40 }, (_, i) => `--v${String(i).padStart(2, '0')}: ${i + 1}`).join('; ')
      const head = `<style>.box { ${declared}; color: var(--read) } :root { --read: red }</style>`
      const found = variablesOf(head, '<i class="box" data-annotate-dom-target="v1">x</i>')
      expect(found).toHaveLength(30)
      expect(found?.[0]).toEqual({ name: '--read', value: 'red' })
      expect(found?.[1]).toEqual({ name: '--v00', value: '1' })
      expect(found?.[29]).toEqual({ name: '--v28', value: '29' })
    })

    it('skips --tw- variables so they never fill the cap, and keeps the app and theme tokens', () => {
      const internals = Array.from({ length: 40 }, (_, i) => `--tw-shadow-${String(i).padStart(2, '0')}: ${i}`).join('; ')
      const head = `<style>.btn { ${internals}; --zeta-ring: 1px; --twin: 2px; color: var(--tw-text-opacity); margin: var(--zeta-gap) } :root { --tw-text-opacity: 1; --zeta-gap: 4px }</style>`
      const found = variablesOf(head, '<button class="btn" data-annotate-dom-target="v1">x</button>')
      expect(found).toEqual([
        { name: '--zeta-gap', value: '4px' },
        { name: '--twin', value: '2px' },
        { name: '--zeta-ring', value: '1px' },
      ])
    })

    it('prints a secret-named variable as [redacted] and keeps the others', () => {
      const head = '<style>.box { --api-key: sk-live-1; --userPin: 1234; --shipping-gap: 4px; --auth-token: abc }</style>'
      expect(variablesOf(head, '<i class="box" data-annotate-dom-target="v1">x</i>')).toEqual([
        { name: '--api-key', value: '[redacted]' },
        { name: '--auth-token', value: '[redacted]' },
        { name: '--shipping-gap', value: '4px' },
        { name: '--userPin', value: '[redacted]' },
      ])
    })

    it('prints a variable as [redacted] when its value reads a secret-named variable, directly or through another alias', () => {
      const head = '<style>:root { --api-key: sk-live-1; --mid: var(--api-key); --plain: 4px } .box { --accent: var(--mid); --safe: var(--plain); color: var(--accent); margin: var(--safe) }</style>'
      expect(variablesOf(head, '<i class="box" data-annotate-dom-target="v1">x</i>')).toEqual([
        { name: '--accent', value: '[redacted]' },
        { name: '--api-key', value: '[redacted]' },
        { name: '--mid', value: '[redacted]' },
        { name: '--plain', value: '4px' },
        { name: '--safe', value: '4px' },
      ])
    })

    it('stops on a reference cycle between rules that do not all apply to the element', () => {
      const head = '<style>:root { --y: 1px } .box { --x: var(--y); margin: var(--x) } .other { --y: var(--x) }</style>'
      expect(variablesOf(head, '<i class="box" data-annotate-dom-target="v1">x</i>')).toEqual([
        { name: '--x', value: '1px' },
        { name: '--y', value: '1px' },
      ])
    })

    it('is empty when the page declares no variables', () => {
      expect(variablesOf('<style>.a { color: red }</style>', '<i class="a" data-annotate-dom-target="v1">x</i>')).toEqual([])
    })

    it('skips a stylesheet it cannot read and still lists the rest', () => {
      document.head.innerHTML = '<style>.box { --ok: 1 }</style>'
      const crossOrigin = {
        get cssRules(): CSSRuleList {
          throw new DOMException('Cannot access rules', 'SecurityError')
        },
      }
      const sheets = Object.assign([crossOrigin, ...Array.from(document.styleSheets)], { item: () => null })
      if (!isStyleSheetList(sheets)) throw new Error('fixture is not a style sheet list')
      vi.spyOn(document, 'styleSheets', 'get').mockReturnValue(sheets)
      document.body.innerHTML = '<i class="box" data-annotate-dom-target="v1">x</i>'
      expect(runInPage('v1')?.cssVariables).toEqual([{ name: '--ok', value: '1' }])
    })

    it('reads the stylesheets of the shadow root the element is in, not the page', () => {
      document.head.innerHTML = '<style>.page-only { --page: 1 }</style>'
      document.body.innerHTML = '<div id="host"></div>'
      const root = document.getElementById('host')?.attachShadow({ mode: 'open' })
      if (!root) throw new Error('fixture missing')
      root.innerHTML = '<style>.inner { --inner: 2 }</style><i class="page-only inner" data-annotate-dom-target="v1">x</i>'
      Object.defineProperty(root, 'styleSheets', { value: [root.querySelector('style')?.sheet] })
      expect(runInPage('v1')?.cssVariables).toEqual([{ name: '--inner', value: '2' }])
    })

    it('reads the stylesheets of the iframe document the element is in', () => {
      document.head.innerHTML = '<style>.page-only { --page: 1 }</style>'
      document.body.innerHTML = '<div id="pane"></div>'
      const frame = document.getElementById('pane')
      const inner = new Window().document
      inner.head.innerHTML = '<style>.inner { --inner: 2 }</style>'
      inner.body.innerHTML = '<i class="page-only inner" data-annotate-dom-target="v1">x</i>'
      if (!frame) throw new Error('fixture missing')
      Object.defineProperty(frame, 'contentDocument', { value: inner })
      Object.defineProperty(inner.defaultView, 'frameElement', { value: frame })
      expect(runInPage('v1')?.cssVariables).toEqual([{ name: '--inner', value: '2' }])
    })

    describe('redaction by resolved value in Chromium', () => {
      const tokens = {
        imported: ':root { --api-key: sk-live-imported; --color: var(--api-key) }',
        crossOrigin: ':root { --auth-token: sk-live-crossorigin; --brand: var(--auth-token) }',
      }
      const pages: Record<string, string> = {
        '/html-style': '<!doctype html><html style="--api-key: sk-live-htmlstyle; --c: var(--api-key)"><head><style>.box { color: var(--c) }</style></head><body><i class="box" data-annotate-dom-target="v1">x</i></body></html>',
        '/import': '<!doctype html><html><head><style>@import url("/imported.css"); .box { color: var(--color) }</style></head><body><i class="box" data-annotate-dom-target="v1">x</i></body></html>',
        '/shadow': '<!doctype html><html><head><style>:root { --session-id: sk-live-shadowed; --color: var(--session-id) }</style></head><body><div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<style>.inner { color: var(--color) }</style><i class=inner data-annotate-dom-target=v1>x</i>"</script></body></html>',
        '/shadow-override': '<!doctype html><html><head><style>#host { --api-key: sk-live-onhost; --color: var(--api-key) }</style></head><body><div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<style>.inner { --api-key: overridden; color: var(--color) }</style><i class=inner data-annotate-dom-target=v1>x</i>"</script></body></html>',
        '/override': '<!doctype html><html><head><style>:root { --api-key: sk-live-rootvalue; --color: var(--api-key) } .box { --api-key: overridden; color: var(--color) }</style></head><body><i class="box" data-annotate-dom-target="v1">x</i></body></html>',
        '/compound': '<!doctype html><html><head><style>:root { --api-key: sk-live-compound } .box { --shadow: 0 0 2px var(--api-key); box-shadow: var(--shadow) }</style></head><body><i class="box" data-annotate-dom-target="v1">x</i></body></html>',
        '/frame-shadow-override': '<!doctype html><html><body><iframe src="/shadow-override"></iframe></body></html>',
        '/short-equal': '<!doctype html><html><head><style>.box { --keyframe-delay: 0s; --radius: 0s; --api-key: sk-live-equal; --same: sk-live-equal; padding: var(--radius); color: var(--same) }</style></head><body><i class="box" data-annotate-dom-target="v1">x</i></body></html>',
        '/short': '<!doctype html><html><head><style>.box { --pin-size: 4px; --gap: 14px; padding: var(--gap) }</style></head><body><i class="box" data-annotate-dom-target="v1">x</i></body></html>',
      }
      const respond = (routes: Record<string, string>) => (req: IncomingMessage, res: ServerResponse) => {
        const body = routes[req.url ?? '']
        res.writeHead(body === undefined ? 404 : 200, { 'content-type': req.url?.endsWith('.css') ? 'text/css' : 'text/html' })
        res.end(body)
      }
      const listen = (server: Server): Promise<number> => new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      }))

      let pageServer: Server
      let tokenServer: Server
      let pageOrigin = ''
      let browser: Browser

      beforeAll(async () => {
        tokenServer = createServer(respond({ '/crossorigin.css': tokens.crossOrigin }))
        const tokenPort = await listen(tokenServer)
        pageServer = createServer(respond({
          ...pages,
          '/imported.css': tokens.imported,
          '/cross-origin': `<!doctype html><html><head><link rel="stylesheet" href="http://127.0.0.1:${tokenPort}/crossorigin.css"><style>.box { color: var(--brand) }</style></head><body><i class="box" data-annotate-dom-target="v1">x</i></body></html>`,
        }))
        pageOrigin = `http://127.0.0.1:${await listen(pageServer)}`
        browser = await chromium.launch()
      })

      afterAll(async () => {
        await browser.close()
        pageServer.close()
        tokenServer.close()
      })

      async function chromiumVariables(path: string): Promise<CssVariable[] | undefined> {
        const page = await browser.newPage()
        try {
          await page.goto(pageOrigin + path)
          return await page.evaluate(({ run }) => new Function(`return ${run}`)()('v1')?.cssVariables, { run: inspectElement.toString() })
        } finally {
          await page.close()
        }
      }

      it.each([
        ['an alias declared on <html style>', '/html-style', '--c'],
        ['an alias in an @imported sheet', '/import', '--color'],
        ['an alias in a cross-origin sheet', '/cross-origin', '--brand'],
        ['a page :root alias seen from a shadow root', '/shadow', '--color'],
        ['an alias on a shadow host whose secret the shadow content overrides', '/shadow-override', '--color'],
        ['an alias whose secret a descendant overrides', '/override', '--color'],
        ['an alias on a shadow host inside a same-origin iframe', '/frame-shadow-override', '--color'],
        ['a compound value that contains the secret', '/compound', '--shadow'],
      ])('redacts %s', async (_label, path, alias) => {
        const variables = await chromiumVariables(path)
        expect(variables?.find(v => v.name === alias)).toEqual({ name: alias, value: '[redacted]' })
        expect(JSON.stringify(variables)).not.toContain('sk-live')
      }, 30_000)

      it('keeps a short value equal to a short secret value and redacts a long one equal to a secret', async () => {
        const variables = await chromiumVariables('/short-equal')
        expect(variables?.find(v => v.name === '--radius')).toEqual({ name: '--radius', value: '0s' })
        expect(variables?.find(v => v.name === '--same')).toEqual({ name: '--same', value: '[redacted]' })
        expect(JSON.stringify(variables)).not.toContain('sk-live')
      }, 30_000)

      it('does not redact a short value that only appears inside another value', async () => {
        expect(await chromiumVariables('/short')).toEqual([
          { name: '--gap', value: '14px' },
          { name: '--pin-size', value: '[redacted]' },
        ])
      }, 30_000)
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

    function pageWithFrame(frameBody: string) {
      document.documentElement.removeAttribute('lang')
      document.head.innerHTML = ''
      document.body.innerHTML = '<div id="pane"></div>'
      const frame = document.getElementById('pane')
      const frameWindow = new Window()
      frameWindow.document.body.innerHTML = frameBody
      if (!frame) throw new Error('fixture missing')
      Object.defineProperty(frame, 'contentDocument', { value: frameWindow.document })
      Object.defineProperty(frameWindow, 'frameElement', { value: frame })
      return frameWindow
    }

    it('runs the frame\'s own axe for a pin inside an iframe, never the top page\'s', async () => {
      const topRun = fakeAxe([{ id: 'document-title', impact: 'serious', nodes: [{ target: ['html'] }] }])
      const frameWindow = pageWithFrame('<img data-annotate-dom-target="f1" src="b.png" />')
      const frameRun = vi.fn(async (_context: Element) => ({ violations: [{ id: 'image-alt', impact: 'critical', nodes: [{ target: ['img'] }] }] }))
      Reflect.set(frameWindow, 'axe', { run: frameRun })
      expect(await runAxeInPage('f1')).toEqual([{ id: 'image-alt', impact: 'critical', selector: 'img' }])
      expect(frameRun.mock.calls[0][0]).toBe(frameWindow.document.querySelector('img'))
      expect(topRun).not.toHaveBeenCalled()
    })

    it('is empty for a pin in an iframe that has no axe', async () => {
      fakeAxe([{ id: 'document-title', impact: 'serious', nodes: [{ target: ['html'] }] }])
      pageWithFrame('<img data-annotate-dom-target="f2" src="b.png" />')
      expect(await runAxeInPage('f2')).toEqual([])
    })

    it('audits only the pinned element of a real iframe in Chromium', async () => {
      const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.setContent('<!doctype html><html><body><iframe id="pane" srcdoc="&lt;!doctype html&gt;&lt;html lang=en&gt;&lt;head&gt;&lt;title&gt;t&lt;/title&gt;&lt;/head&gt;&lt;body&gt;&lt;main&gt;&lt;h1&gt;h&lt;/h1&gt;&lt;button id=ok&gt;Ok&lt;/button&gt;&lt;img id=bad src=b.png&gt;&lt;/main&gt;&lt;/body&gt;&lt;/html&gt;"></iframe></body></html>')
        await page.frameLocator('#pane').locator('#ok').waitFor()
        await page.addScriptTag({ content: axeSource })
        await page.frame({ url: 'about:srcdoc' })?.addScriptTag({ content: axeSource })
        const audit = (id: string): Promise<string[]> => page.evaluate(
          async ({ run, id }) => {
            const el = document.querySelector('iframe')?.contentDocument?.getElementById(id)
            el?.setAttribute('data-annotate-dom-target', 'pin')
            const found = await new Function(`return ${run}`)()('pin')
            el?.removeAttribute('data-annotate-dom-target')
            return found.map((v: { id: string }) => v.id)
          },
          { run: axeViolations.toString(), id },
        )
        expect(await audit('ok')).toEqual([])
        expect(await audit('bad')).toEqual(['image-alt'])
      } finally {
        await browser.close()
      }
    }, 60_000)
  })
})
