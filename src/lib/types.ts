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
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number }
  readonly react: ReactSnapshot | null
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
