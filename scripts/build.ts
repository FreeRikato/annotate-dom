import { build } from 'vite'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const test = process.argv.includes('--test')
const outDir = resolve(import.meta.dirname, '..', test ? 'dist-test' : 'dist')

await build({
  configFile: false,
  build: {
    outDir,
    emptyOutDir: true,
    lib: { entry: resolve(import.meta.dirname, '../src/background.ts'), formats: ['es'], fileName: () => 'background.js' },
  },
})

await build({
  configFile: false,
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: false,
    lib: { entry: resolve(import.meta.dirname, '../src/content.ts'), formats: ['iife'], name: 'annotateDom', fileName: () => 'content.js' },
  },
})

await build({
  configFile: false,
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: false,
    lib: { entry: resolve(import.meta.dirname, '../src/recorder.ts'), formats: ['iife'], name: 'annotateDomRecorder', fileName: () => 'recorder.js' },
  },
})

if (test) {
  const path = resolve(outDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.host_permissions = ['<all_urls>']
  await writeFile(path, JSON.stringify(manifest, null, 2))
}
