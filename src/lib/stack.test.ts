import { describe, expect, it } from 'vitest'
import { callSiteFrame, isServerFrame, normalizeSource, projectRootFromServerFile, serverFileUrl } from './stack'

const clientStack = `Error: react-stack-top-frame
    at exports.jsxDEV (http://localhost:3000/_next/static/chunks/node_modules__pnpm_1opx5pi._.js:2339:33)
    at ThemeToggle (http://localhost:3000/_next/static/chunks/_19bvaps._.js:106:450)
    at Object.react_stack_bottom_frame (http://localhost:3000/_next/static/chunks/0juj_next_dist_compiled_react-dom_090tbzs._.js:14894:24)`

const serverStack = `Error: react-stack-top-frame
    at fakeJSXCallSite (http://localhost:3000/_next/static/chunks/0juj_next_dist_compiled_react-server-dom-turbopack_0tv87lf._.js:2001:21)
    at LoginPage (about://React/Server/file:///Users/me/granite/.next/dev/server/chunks/ssr/%5Broot-of-the-server%5D__1mh83pb._.js?16:92:500)
    at Object.react_stack_bottom_frame (http://localhost:3000/_next/static/chunks/0juj_next_dist_compiled_react-server-dom-turbopack_0tv87lf._.js:2768:93)`

const viteStack = `Error: react-stack-top-frame
    at jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:20:15)
    at App (http://localhost:5173/src/App.tsx?t=17:12:7)`

describe('callSiteFrame', () => {
  it('skips React internals and returns the component that created the element', () => {
    expect(callSiteFrame(clientStack)).toEqual({
      fn: 'ThemeToggle',
      file: 'http://localhost:3000/_next/static/chunks/_19bvaps._.js',
      line: 106,
      column: 450,
    })
  })

  it('keeps server component frames intact', () => {
    const frame = callSiteFrame(serverStack)
    expect(frame?.fn).toBe('LoginPage')
    expect(frame && isServerFrame(frame)).toBe(true)
    expect(frame && serverFileUrl(frame)).toBe(
      'file:///Users/me/granite/.next/dev/server/chunks/ssr/%5Broot-of-the-server%5D__1mh83pb._.js',
    )
  })

  it('handles the Vite jsxDEV wrapper', () => {
    expect(callSiteFrame(viteStack)).toMatchObject({ fn: 'App', line: 12, column: 7 })
  })

  it('returns null without a stack', () => {
    expect(callSiteFrame(null)).toBeNull()
    expect(callSiteFrame('Error: nothing')).toBeNull()
  })
})

describe('paths', () => {
  it('derives the Next project root from a server chunk', () => {
    expect(projectRootFromServerFile('file:///Users/me/my%20app/.next/dev/server/x.js')).toBe('/Users/me/my app')
    expect(projectRootFromServerFile('file:///Users/me/app/dist/x.js')).toBeNull()
  })

  it('normalizes file and same-origin sources', () => {
    expect(normalizeSource({ source: 'file:///Users/me/app/a.tsx', pageOrigin: 'http://localhost:3000' })).toBe('/Users/me/app/a.tsx')
    expect(normalizeSource({ source: 'http://localhost:5173/src/App.tsx?t=1', pageOrigin: 'http://localhost:5173' })).toBe('src/App.tsx')
  })
})
