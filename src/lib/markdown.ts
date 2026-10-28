import { classifySourcePath } from './callsites'
import type { BoxModel, DetailLevel, Pin, SourceLoc } from './types'

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

const DEFAULT_STYLES: Readonly<Record<string, readonly string[]>> = {
  position: ['static'],
  opacity: ['1'],
  visibility: ['visible'],
  'z-index': ['auto'],
  'background-color': ['transparent', 'rgba(0, 0, 0, 0)'],
  'box-shadow': ['none'],
  'border-radius': ['0px'],
  overflow: ['visible'],
  gap: ['normal'],
  'align-items': ['normal'],
  'justify-content': ['normal'],
  'pointer-events': ['auto'],
  cursor: ['auto'],
}

const ZERO_WIDTH_BORDER = /^0px\b/

function isDefaultStyle(key: string, value: string): boolean {
  return DEFAULT_STYLES[key]?.includes(value) === true || (key === 'border' && ZERO_WIDTH_BORDER.test(value))
}

const BOX_SHORTHANDS = ['margin', 'padding']
const FLEX_KEYS = ['flex-direction']
const ALIGN_KEYS = ['justify-content', 'align-items']
const GRID_KEYS = ['grid-template-columns']

function styleLine(styles: Readonly<Record<string, string>>, skip: (key: string) => boolean = () => false): string {
  const display = styles.display ?? ''
  const flex = display === 'flex' || display === 'inline-flex'
  const grid = display === 'grid' || display === 'inline-grid'
  const notApplicable = (k: string) => (FLEX_KEYS.includes(k) && !flex) || (ALIGN_KEYS.includes(k) && !flex && !grid) || (GRID_KEYS.includes(k) && !grid) || (k === 'gap' && !flex && !grid)
  return Object.entries(styles)
    .filter(([k, v]) => v !== '' && !isDefaultStyle(k, v) && !notApplicable(k) && !skip(k))
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ')
}

function boxModelLine({ margin, padding, border }: BoxModel): string {
  return `- Box model: margin ${margin.join(' ')}, padding ${padding.join(' ')}, border ${border.join(' ')}`
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
  const lines = [pin.note ? `### ${n}. ${pin.note.split('\n')[0]}` : `### ${ins.selector}`]
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
  if (ins.cssVariables?.length) lines.push(`- CSS variables: ${ins.cssVariables.map(v => `${v.name}: ${v.value}`).join('; ')}`)
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
  if (ins.selectedText) lines.push(`- ${selectedTextLine(ins.selectedText)}`)
  lines.push(`- Box: x=${ins.box.x} y=${ins.box.y} w=${ins.box.w} h=${ins.box.h}`)
  if (ins.boxModel) lines.push(boxModelLine(ins.boxModel))
  const styles = styleLine(ins.styles, k => ins.boxModel !== undefined && BOX_SHORTHANDS.includes(k))
  if (styles) lines.push(`- Styles: ${styles}`)
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

function selectedTextLine(text: string): string {
  return `Selected text: ${JSON.stringify(text)}`
}

function compactLine({ pin }: ExportPin, n: number): string[] {
  const site = pin.elementSite
  const { selectedText } = pin.inspection
  const where = `${n}. **${pin.inspection.selector}** (${site ? `${site.file}:${site.line}` : 'no source'})`
  const line = pin.note ? `${where}: ${pin.note.split('\n')[0]}` : where
  const heading = pin.note ? [] : [`### ${pin.inspection.selector}`]
  return [...heading, line, ...(selectedText ? [selectedTextLine(selectedText)] : [])]
}

function environment(page: ExportPage): string[] {
  const first = page.pins[0]?.pin
  if (!first) return []
  const { viewport } = first.inspection
  return [
    '- Environment:',
    `  - Viewport: ${viewport.width}x${viewport.height}`,
    `  - DPR: ${viewport.dpr}`,
    `  - User agent: ${viewport.userAgent ?? 'unknown'}`,
    `  - URL: ${page.url}`,
    `  - Captured: ${stamp(first.createdAt)}`,
  ]
}

export function toMarkdown({ origin, createdAt, pages, level = 'standard' }: {
  readonly origin: string
  readonly createdAt: number
  readonly pages: readonly ExportPage[]
  readonly level?: DetailLevel
}): string {
  const total = pages.reduce((sum, p) => sum + p.pins.length, 0)
  const out = [
    `# annotate-dom: ${origin} (${stamp(createdAt)})`,
    '',
    `${total} annotation${total === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'}. ${level === 'compact' ? 'Each numbered line is one change request.' : 'Screenshots are PNG files; open them by path. Each numbered section is one change request.'}`,
  ]
  let n = 0
  if (level === 'compact') {
    for (const page of pages) {
      out.push('', `## ${page.path}`, '')
      for (const pin of page.pins) out.push(...compactLine(pin, ++n))
    }
    return out.join('\n') + '\n'
  }
  for (const page of pages) {
    const vp = page.pins[0]?.pin.inspection.viewport
    out.push('', `## ${page.path}`, '', `- URL: ${page.url}`)
    if (vp) out.push(`- Viewport: ${vp.width}x${vp.height} @${vp.dpr}x`)
    out.push(`- Viewport screenshot (pins numbered): ${page.viewportFile ?? 'not saved'}`)
    if (level === 'forensic') out.push(...environment(page))
    for (const pin of page.pins) {
      n += 1
      out.push('', ...pinSection(pin, n))
    }
  }
  return out.join('\n') + '\n'
}
