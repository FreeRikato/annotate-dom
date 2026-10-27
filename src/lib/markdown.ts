import type { Pin, SourceLoc } from './types'

export type ExportPin = { readonly pin: Pin; readonly cropFile: string | null }

export type ExportPage = {
  readonly path: string
  readonly url: string
  readonly viewportFile: string | null
  readonly pins: readonly ExportPin[]
}

function loc(source: SourceLoc | null): string {
  if (!source) return 'unresolved'
  const at = `${source.line}:${source.column}`
  const lib = source.file.lastIndexOf('/node_modules/')
  if (lib === -1) return `${source.file}:${at}`
  return `library code (${source.file.slice(lib + '/node_modules/'.length).replace(/^\.pnpm\/[^/]+\/node_modules\//, '')}:${at})`
}

function code(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``
}

function styleLine(styles: Readonly<Record<string, string>>): string {
  return Object.entries(styles)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ')
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function pinSection({ pin, cropFile }: ExportPin, n: number): string[] {
  const { inspection: ins } = pin
  const owners = ins.react?.owners ?? []
  const lines = [`### ${n}. ${pin.note.split('\n')[0]}`]
  if (pin.note.includes('\n')) lines.push('', pin.note, '')
  lines.push(`- Screenshot: ${cropFile ?? 'not saved'}`)
  if (ins.react) {
    lines.push(`- Source: ${loc(pin.elementSite)} (${code(`<${ins.tag}>`)} element)`)
    if (owners.length) {
      lines.push(`- Components: ${owners.map(o => o.name).reverse().join(' > ')}`)
      lines.push('- Call sites (innermost first):')
      lines.push(`  - ${code(`<${ins.tag}>`)} at ${loc(pin.elementSite)}`)
      for (const [i, site] of pin.callSites.entries()) {
        const env = owners[i]?.env === 'server' ? ' (server component)' : ''
        lines.push(`  - ${code(`<${site.name}>`)}${env} at ${loc(site.loc)}`)
      }
    }
  } else {
    lines.push('- Source: no React dev data on this element')
  }
  lines.push(`- Selector: ${code(ins.selector)}`)
  if (ins.text) lines.push(`- Text: ${code(ins.text.replace(/\s+/g, ' '))}`)
  lines.push(`- Box: x=${ins.box.x} y=${ins.box.y} w=${ins.box.w} h=${ins.box.h}`)
  lines.push(`- Styles: ${styleLine(ins.styles)}`)
  const attrs = Object.entries(ins.attributes).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
  if (attrs.length) lines.push(`- Attributes: ${attrs.join(', ')}`)
  for (const owner of owners) {
    if (owner.props) lines.push(`- Props of ${owner.name}: ${code(owner.props)}`)
    if (owner.state) lines.push(`- State of ${owner.name} (useState/useReducer in hook order): ${code(owner.state)}`)
  }
  if (ins.ancestors.length) {
    lines.push('- Parents (nearest first):')
    for (const a of ins.ancestors) lines.push(`  - ${code(a.selector)}: ${styleLine(a.styles)}`)
  }
  lines.push(`- HTML${ins.htmlTruncated ? ' (first 10000 chars)' : ''}:`, '', '````html', ins.html, '````')
  return lines
}

export function toMarkdown({ origin, createdAt, pages }: {
  readonly origin: string
  readonly createdAt: number
  readonly pages: readonly ExportPage[]
}): string {
  const total = pages.reduce((sum, p) => sum + p.pins.length, 0)
  const out = [
    `# annotate-dom: ${origin} (${stamp(createdAt)})`,
    '',
    `${total} annotation${total === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'}. Screenshots are PNG files; open them by path. Each numbered section is one change request.`,
  ]
  let n = 0
  for (const page of pages) {
    const vp = page.pins[0]?.pin.inspection.viewport
    out.push('', `## ${page.path}`, '', `- URL: ${page.url}`)
    if (vp) out.push(`- Viewport: ${vp.width}x${vp.height} @${vp.dpr}x`)
    out.push(`- Viewport screenshot (pins numbered): ${page.viewportFile ?? 'not saved'}`)
    for (const pin of page.pins) {
      n += 1
      out.push('', ...pinSection(pin, n))
    }
  }
  return out.join('\n') + '\n'
}
