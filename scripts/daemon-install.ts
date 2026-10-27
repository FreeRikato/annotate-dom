import { mkdir, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const LABEL = 'com.annotate-dom.daemon'
export const MCP_ADD_LINE = 'claude mcp add --transport http annotate-dom http://localhost:4747/mcp'

export type Launchctl = (args: readonly string[]) => Promise<void>

export const plistPath = (home: string) => join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)

const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function buildPlist({ home, bun, repo }: { readonly home: string; readonly bun: string; readonly repo: string }): string {
  const log = join(home, '.annotate-dom', 'daemon.log')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(bun)}</string>
    <string>${escapeXml(join(repo, 'server', 'main.ts'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(repo)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(log)}</string>
</dict>
</plist>
`
}

export async function install({ home, bun, repo, uid, launchctl }: {
  readonly home: string
  readonly bun: string
  readonly repo: string
  readonly uid: number
  readonly launchctl: Launchctl
}): Promise<string> {
  const path = plistPath(home)
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
  await mkdir(join(home, '.annotate-dom'), { recursive: true })
  await writeFile(path, buildPlist({ home, bun, repo }))
  await launchctl(['bootout', `gui/${uid}/${LABEL}`]).catch(() => undefined)
  await launchctl(['bootstrap', `gui/${uid}`, path])
  return MCP_ADD_LINE
}

export async function uninstall({ home, uid, launchctl }: {
  readonly home: string
  readonly uid: number
  readonly launchctl: Launchctl
}): Promise<string> {
  await launchctl(['bootout', `gui/${uid}/${LABEL}`]).catch(() => undefined)
  await rm(plistPath(home), { force: true })
  return MCP_ADD_LINE
}

export const realLaunchctl: Launchctl = async args => {
  const proc = Bun.spawn(['launchctl', ...args], { stdout: 'inherit', stderr: 'inherit' })
  if ((await proc.exited) !== 0) throw new Error(`launchctl ${args.join(' ')} failed`)
}

if (import.meta.main) {
  const line = await install({
    home: homedir(),
    bun: process.execPath,
    repo: resolve(import.meta.dirname, '..'),
    uid: process.getuid?.() ?? 501,
    launchctl: realLaunchctl,
  })
  console.log(`Installed ${plistPath(homedir())}\nRegister it with Claude Code:\n  ${line}`)
}
