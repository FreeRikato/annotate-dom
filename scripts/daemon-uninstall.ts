import { homedir } from 'node:os'
import { plistPath, realLaunchctl, uninstall } from './daemon-install'

const line = await uninstall({ home: homedir(), uid: process.getuid?.() ?? 501, launchctl: realLaunchctl })
console.log(`Removed ${plistPath(homedir())}\nTo register it again:\n  ${line}`)
