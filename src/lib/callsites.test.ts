import { describe, expect, it } from 'vitest'
import { classifySourcePath, selectCallSites, withSelectedCallSites } from './callsites'
import type { CallSite, Inspection, OwnerSnapshot, SourceLoc } from './types'

const at = (file: string): SourceLoc => ({ file, line: 1, column: 1 })

describe('classifySourcePath', () => {
  it('names the package behind a node_modules path', () => {
    expect(classifySourcePath(at('/app/node_modules/@radix-ui/react-menu/dist/index.mjs'))).toEqual({ origin: 'package', packageName: '@radix-ui/react-menu' })
    expect(classifySourcePath(at('/app/node_modules/.pnpm/next@16.3.4_x/node_modules/next/dist/rsc.js'))).toEqual({ origin: 'package', packageName: 'next' })
    expect(classifySourcePath(at('/app/node_modules/lodash/get.js'))).toEqual({ origin: 'package', packageName: 'lodash' })
  })

  it('names the package behind a relative node_modules path', () => {
    expect(classifySourcePath(at('node_modules/@radix-ui/react-menu/dist/index.mjs'))).toEqual({ origin: 'package', packageName: '@radix-ui/react-menu' })
    expect(classifySourcePath(at('./node_modules/lodash/get.js'))).toEqual({ origin: 'package', packageName: 'lodash' })
  })

  it('calls anything else app code, and a missing location unknown', () => {
    expect(classifySourcePath(at('/app/src/user-menu.tsx'))).toEqual({ origin: 'app' })
    expect(classifySourcePath(null)).toEqual({ origin: 'unknown' })
  })
})

function owner(name: string): OwnerSnapshot {
  return { name, env: 'client', stack: 'x', props: `{"n":"${name}"}`, state: `["${name}"]` }
}

function site(name: string, file: string | null): CallSite {
  return { name, loc: file ? at(file) : null }
}

function chain(names: readonly string[], file: (name: string) => string | null) {
  return { owners: names.map(owner), sites: names.map(n => site(n, file(n))) }
}

describe('selectCallSites', () => {
  it('keeps every library owner in front of the first 6 app owners', () => {
    const names = ['L1', 'L2', 'L3', 'L4', 'A1', 'A2', 'A3', 'A4']
    const { owners, sites } = chain(names, n => (n.startsWith('L') ? '/app/node_modules/lib/x.js' : '/app/src/a.tsx'))
    const kept = selectCallSites(owners, sites)
    expect(kept.owners.map(o => o.name)).toEqual(names)
    expect(kept.callSites.map(s => s.name)).toEqual(names)
  })

  it('stops after the 6th app owner', () => {
    const names = Array.from({ length: 9 }, (_, i) => `A${i + 1}`)
    const { owners, sites } = chain(names, () => '/app/src/a.tsx')
    const kept = selectCallSites(owners, sites)
    expect(kept.owners.map(o => o.name)).toEqual(names.slice(0, 6))
    expect(kept.callSites.map(s => s.name)).toEqual(names.slice(0, 6))
  })

  it('counts an unresolved call site as an app owner', () => {
    const names = Array.from({ length: 8 }, (_, i) => `U${i + 1}`)
    const { owners, sites } = chain(names, () => null)
    expect(selectCallSites(owners, sites).owners).toHaveLength(6)
  })

  it('keeps props and state on the first 3 app owners only', () => {
    const names = ['L1', 'A1', 'L2', 'A2', 'A3', 'A4', 'A5']
    const { owners, sites } = chain(names, n => (n.startsWith('L') ? '/app/node_modules/lib/x.js' : '/app/src/a.tsx'))
    const withData = selectCallSites(owners, sites).owners.filter(o => o.props !== null || o.state !== null)
    expect(withData.map(o => o.name)).toEqual(['A1', 'A2', 'A3'])
    for (const o of selectCallSites(owners, sites).owners) expect(o.props === null).toBe(o.state === null)
  })

  it('keeps owners and call sites aligned when there are fewer call sites than owners', () => {
    const { owners, sites } = chain(['A1', 'A2', 'A3'], () => '/app/src/a.tsx')
    const kept = selectCallSites(owners, sites.slice(0, 2))
    expect(kept.owners.map(o => o.name)).toEqual(['A1', 'A2'])
    expect(kept.callSites.map(s => s.name)).toEqual(['A1', 'A2'])
  })
})

describe('withSelectedCallSites', () => {
  const inspection: Inspection = {
    selector: 'button',
    tag: 'button',
    html: '<button></button>',
    htmlTruncated: false,
    text: '',
    box: { x: 0, y: 0, w: 1, h: 1 },
    styles: {},
    attributes: {},
    ancestors: [],
    viewport: { width: 1, height: 1, dpr: 1 },
    react: { elementStack: 'x', owners: Array.from({ length: 9 }, (_, i) => owner(`A${i + 1}`)) },
  }

  it('replaces the inspection owners with the selected ones, aligned with the call sites', () => {
    const sites = Array.from({ length: 9 }, () => at('/app/src/a.tsx'))
    const selected = withSelectedCallSites(inspection, sites)
    expect(selected.inspection.react?.owners.map(o => o.name)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6'])
    expect(selected.callSites.map(s => s.name)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6'])
    expect(selected.inspection.react?.owners[5].props).toBeNull()
    expect(selected.inspection.react?.elementStack).toBe('x')
  })

  it('leaves an inspection without React untouched and has no call sites', () => {
    const plain = { ...inspection, react: null }
    expect(withSelectedCallSites(plain, [])).toEqual({ inspection: plain, callSites: [] })
  })
})
