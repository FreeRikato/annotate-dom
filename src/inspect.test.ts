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
