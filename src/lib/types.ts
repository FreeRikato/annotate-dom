export type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export type Ancestor = { readonly selector: string; readonly styles: Readonly<Record<string, string>> }

export type OwnerSnapshot = {
  readonly name: string
  readonly env: 'client' | 'server'
  readonly stack: string | null
  readonly props: string | null
  readonly state: string | null
}

export type ReactSnapshot = {
  readonly elementStack: string | null
  readonly owners: readonly OwnerSnapshot[]
}

export type RecordedConsole = { readonly at: number; readonly message: string }

export type RecordedRequest = {
  readonly at: number
  readonly method: string
  readonly url: string
  readonly status: number | null
  readonly durationMs: number
}

export type RecordedEvents = {
  readonly console: readonly RecordedConsole[]
  readonly network: readonly RecordedRequest[]
}

export type ConsoleEvent = { readonly offsetMs: number; readonly message: string }

export type NetworkEvent = Omit<RecordedRequest, 'at'> & { readonly offsetMs: number }

export type QuerySnapshot = {
  readonly key: string
  readonly status: string
  readonly fetchStatus: string
  readonly dataUpdatedAt: number
  readonly error: string | null
  readonly dataShape: string
}

export type Interaction = {
  readonly focused: string | null
  readonly hovered: string | null
  readonly dialogs: readonly string[]
  readonly searchParams: readonly { readonly key: string; readonly value: string }[]
}

export type TokenValue = {
  readonly prop: string
  readonly value: string
  readonly token: string | null
}

export type DesignTokens = {
  readonly classes: readonly string[]
  readonly values: readonly TokenValue[]
}

export type AxeViolation = {
  readonly id: string
  readonly impact: string | null
  readonly selector: string
}

export type Accessibility = {
  readonly role: string | null
  readonly name: string
  readonly states: readonly string[]
  readonly violations: readonly AxeViolation[]
}

export type DetailLevel = 'compact' | 'standard' | 'forensic'

export const DETAIL_LEVELS: readonly DetailLevel[] = ['compact', 'standard', 'forensic']

export function isDetailLevel(value: unknown): value is DetailLevel {
  return DETAIL_LEVELS.some(level => level === value)
}

export type Inspection = {
  readonly selector: string
  readonly tag: string
  readonly html: string
  readonly htmlTruncated: boolean
  readonly text: string
  readonly box: Box
  readonly styles: Readonly<Record<string, string>>
  readonly attributes: Readonly<Record<string, string>>
  readonly ancestors: readonly Ancestor[]
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number; readonly userAgent?: string }
  readonly react: ReactSnapshot | null
  readonly console?: readonly ConsoleEvent[]
  readonly network?: readonly NetworkEvent[]
  readonly queries?: readonly QuerySnapshot[]
  readonly interaction?: Interaction
  readonly tokens?: DesignTokens
  readonly locator?: string | null
  readonly a11y?: Accessibility
}

export type SourceLoc = { readonly file: string; readonly line: number; readonly column: number }

export type CallSite = { readonly name: string; readonly loc: SourceLoc | null }

export type Pin = {
  readonly id: string
  readonly path: string
  readonly url: string
  readonly note: string
  readonly createdAt: number
  readonly inspection: Inspection
  readonly elementSite: SourceLoc | null
  readonly callSites: readonly CallSite[]
  readonly crop: string
}

export type ViewportShot = {
  readonly image: string
  readonly dpr: number
  readonly rects: Readonly<Record<string, Box>>
}

export type Batch = {
  readonly pins: readonly Pin[]
  readonly viewports: Readonly<Record<string, ViewportShot>>
}

export const emptyBatch: Batch = { pins: [], viewports: {} }

export const PROJECT_ROOT_NOT_FOUND = 'project root not found'
