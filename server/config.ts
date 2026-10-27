import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export const DEFAULT_PORT = 4747

export function extensionIdFromKey(base64Key: string): string {
  const hex = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map(c => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('')
}

export async function resolveExtensionId({ env, manifestPath }: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly manifestPath: string
}): Promise<string> {
  const fromEnv = env.ANNOTATE_DOM_EXTENSION_ID
  if (fromEnv) return fromEnv
  const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (typeof manifest === 'object' && manifest !== null && 'key' in manifest && typeof manifest.key === 'string') {
    return extensionIdFromKey(manifest.key)
  }
  throw new Error(`No extension id: set ANNOTATE_DOM_EXTENSION_ID or add a "key" to ${manifestPath}`)
}
