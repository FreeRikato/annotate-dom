import { join } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_PORT, resolveExtensionId } from './config'
import { createDaemon } from './daemon'

const manifestPath = join(import.meta.dirname, '..', 'public', 'manifest.json')
const extensionId = await resolveExtensionId({ env: process.env, manifestPath })
const port = Number(process.env.ANNOTATE_DOM_PORT ?? DEFAULT_PORT)
const daemon = await createDaemon({ port, home: join(homedir(), '.annotate-dom'), extensionId })

console.log(`annotate-dom daemon listening on http://localhost:${daemon.port}`)
