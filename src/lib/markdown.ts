import { classifySourcePath } from './callsites'
import type { Pin, SourceLoc } from './types'

export type Excerpt = { readonly file: string; readonly line: number; readonly startLine: number; readonly code: string }

export type ExportPin = { readonly pin: Pin; readonly cropFile: string | null; readonly excerpts?: readonly Excerpt[] }

export type ExportPage = {
  readonly path: string
  readonly url: string
  readonly viewportFile: string | null
  readonly pins: readonly ExportPin[]
}

function loc(source: SourceLoc | null): string {
  if (!source) return 'unresolved'
  return `${source.file}:${source.line}:${source.column}`
}

function placed(source: SourceLoc | null): string {
  const origin = classifySourcePath(source)
  return origin.origin === 'package' ? `in ${origin.packageName}` : `at ${loc(source)}`
}

function elementSource(source: SourceLoc | null): string {
  const origin = classifySourcePath(source)
  return origin.origin === 'package' ? `library code in ${origin.packageName}` : loc(source)
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

function secondsBefore(offsetMs: number): string {
  return `${(Math.abs(offsetMs) / 1000).toFixed(1)} s before`
}

function pinSection({ pin, cropFile, excerpts = [] }: ExportPin, n: number): string[] {
  const { inspection: ins } = pin
  const owners = ins.react?.owners ?? []
  const lines = [`### ${n}. ${pin.note.split('\n')[0]}`]
  if (pin.note.includes('\n')) lines.push('', pin.note, '')
  lines.push(`- Screenshot: ${cropFile ?? 'not saved'}`)
  if (ins.react) {
    lines.push(`- Source: ${elementSource(pin.elementSite)} (${code(`<${ins.tag}>`)} element)`)
    for (const { file, line, startLine, code: text } of excerpts) {
      lines.push(`- Code around ${file}:${line} (lines ${startLine} to ${startLine + text.split('\n').length - 1}):`, '', '````', text, '````')
    }
    if (owners.length) {
      lines.push(`- Components: ${owners.map(o => o.name).reverse().join(' > ')}`)
      lines.push('- Call sites (innermost first):')
      lines.push(`  - ${code(`<${ins.tag}>`)} ${placed(pin.elementSite)}`)
      for (const [i, site] of pin.callSites.entries()) {
        const env = owners[i]?.env === 'server' ? ' (server component)' : ''
        lines.push(`  - ${code(`<${site.name}>`)}${env} ${placed(site.loc)}`)
      }
    }
  } else {
    lines.push('- Source: no React dev data on this element')
  }
  lines.push(`- Selector: ${code(ins.selector)}`)
  if (ins.locator) lines.push(`- Locator: ${code(ins.locator)}`)
  if (ins.tokens?.classes.length) lines.push(`- Classes: ${code(ins.tokens.classes.join(' '))}`)
  if (ins.tokens?.values.length) {
    lines.push(`- Tokens: ${ins.tokens.values.map(v => `${v.prop}: ${v.value} ${v.token ? `= ${v.token}` : '(no token)'}`).join('; ')}`)
  }
  if (ins.a11y) {
    const { role, name, states, violations } = ins.a11y
    const facts = [role ? `role ${code(role)}` : 'no role', name ? `name ${code(name)}` : 'no name']
    if (states.length) facts.push(`states ${code(states.join(', '))}`)
    lines.push(`- Accessibility: ${facts.join(', ')}`)
    if (violations.length) {
      lines.push(`- Axe violations: ${violations.map(v => `${code(v.id)}${v.impact ? ` (${v.impact})` : ''} at ${code(v.selector)}`).join('; ')}`)
    }
  }
  if (ins.text) lines.push(`- Text: ${code(ins.text.replace(/\s+/g, ' '))}`)
  lines.push(`- Box: x=${ins.box.x} y=${ins.box.y} w=${ins.box.w} h=${ins.box.h}`)
  lines.push(`- Styles: ${styleLine(ins.styles)}`)
  const attrs = Object.entries(ins.attributes).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
  if (attrs.length) lines.push(`- Attributes: ${attrs.join(', ')}`)
  for (const owner of owners) {
    if (owner.props) lines.push(`- Props of ${owner.name}: ${code(owner.props)}`)
    if (owner.state) lines.push(`- State of ${owner.name} (useState/useReducer in hook order): ${code(owner.state)}`)
  }
  if (ins.console?.length) {
    lines.push('- Console errors in the 30 s before the pin:')
    for (const e of ins.console) lines.push(`  - ${secondsBefore(e.offsetMs)}: ${code(e.message)}`)
  }
  if (ins.network?.length) {
    lines.push('- Failed or slow requests in the 30 s before the pin:')
    for (const r of ins.network) {
      lines.push(`  - ${secondsBefore(r.offsetMs)}: ${r.method} ${code(r.url)} ${r.status ?? 'failed'} in ${r.durationMs} ms`)
    }
  }
  if (ins.queries?.length) {
    lines.push('- Queries:')
    for (const q of ins.queries) {
      const updated = q.dataUpdatedAt ? `updated ${stamp(q.dataUpdatedAt)}` : 'never updated'
      lines.push(`  - ${code(q.key)}: ${q.status}, ${q.fetchStatus}, ${updated}, data ${q.dataShape}${q.error ? `, error ${code(q.error)}` : ''}`)
    }
  }
  const { focused, hovered, dialogs, searchParams } = ins.interaction ?? { focused: null, hovered: null, dialogs: [], searchParams: [] }
  if (focused) lines.push(`- Focused: ${code(focused)}`)
  if (hovered) lines.push(`- Hovered: ${code(hovered)}`)
  if (dialogs.length) lines.push(`- Open dialogs: ${dialogs.map(code).join(', ')}`)
  if (searchParams.length) lines.push(`- Search params: ${searchParams.map(p => `${p.key}=${p.value}`).join(', ')}`)
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
