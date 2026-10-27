import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LABEL, MCP_ADD_LINE, buildPlist, install, plistPath, uninstall } from './daemon-install'

let home: string
let calls: string[][]

const launchctl = async (args: readonly string[]) => { calls.push([...args]) }

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'daemon-install-'))
  calls = []
})

afterEach(() => rm(home, { recursive: true, force: true }))

test('install writes a plist that runs the daemon at login and keeps it alive', async () => {
  await install({ home, bun: '/opt/bun', repo: '/work/annotate-dom', uid: 501, launchctl })
  const path = join(home, 'Library', 'LaunchAgents', 'com.annotate-dom.daemon.plist')
  expect(plistPath(home)).toBe(path)
  const plist = await readFile(path, 'utf8')
  expect(plist).toContain(`<key>Label</key>\n  <string>${LABEL}</string>`)
  expect(plist).toContain('<string>/opt/bun</string>\n    <string>/work/annotate-dom/server/main.ts</string>')
  expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>')
  expect(plist).toContain('<key>KeepAlive</key>\n  <true/>')
  expect(plist).toContain(`<string>${join(home, '.annotate-dom', 'daemon.log')}</string>`)
  expect(calls.at(-1)).toEqual(['bootstrap', 'gui/501', path])
})

test('install prints the claude mcp add line', async () => {
  const line = await install({ home, bun: '/opt/bun', repo: '/work/app', uid: 501, launchctl })
  expect(line).toBe('claude mcp add --transport http annotate-dom http://localhost:4747/mcp')
  expect(MCP_ADD_LINE).toBe(line)
})

test('install replaces a daemon that is already loaded', async () => {
  await install({ home, bun: '/opt/bun', repo: '/work/app', uid: 501, launchctl })
  expect(calls.map(c => c[0])).toEqual(['bootout', 'bootstrap'])
})

test('uninstall unloads the daemon, removes the plist and prints the registration line', async () => {
  await install({ home, bun: '/opt/bun', repo: '/work/app', uid: 501, launchctl })
  calls = []
  const line = await uninstall({ home, uid: 501, launchctl })
  expect(calls).toEqual([['bootout', `gui/501/${LABEL}`]])
  expect(existsSync(plistPath(home))).toBe(false)
  expect(line).toBe(MCP_ADD_LINE)
})

test('uninstall succeeds when nothing was installed', async () => {
  const failing = async () => { throw new Error('not loaded') }
  await uninstall({ home, uid: 501, launchctl: failing })
  expect(existsSync(plistPath(home))).toBe(false)
})

test('paths with markup characters are escaped', () => {
  expect(buildPlist({ home: '/h', bun: '/b', repo: '/a&b<c>' })).toContain('/a&amp;b&lt;c&gt;/server/main.ts')
})
