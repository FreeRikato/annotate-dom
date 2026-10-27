import type { CallSite, Inspection, OwnerSnapshot, SourceLoc } from './types'

const APP_OWNERS_KEPT = 6
const APP_OWNERS_WITH_DATA = 3
const PACKAGE_DIR = /(?:^|\/)node_modules\//g

export type SourceOrigin =
  | { readonly origin: 'package'; readonly packageName: string }
  | { readonly origin: 'app' }
  | { readonly origin: 'unknown' }

export function classifySourcePath(loc: SourceLoc | null): SourceOrigin {
  if (!loc) return { origin: 'unknown' }
  const dir = [...loc.file.matchAll(PACKAGE_DIR)].at(-1)
  if (!dir) return { origin: 'app' }
  const [first = '', second = ''] = loc.file.slice(dir.index + dir[0].length).split('/')
  return { origin: 'package', packageName: first.startsWith('@') ? `${first}/${second}` : first }
}

export function selectCallSites(
  owners: readonly OwnerSnapshot[],
  sites: readonly CallSite[],
): { readonly owners: readonly OwnerSnapshot[]; readonly callSites: readonly CallSite[] } {
  const keptOwners: OwnerSnapshot[] = []
  const keptSites: CallSite[] = []
  let appOwners = 0
  for (const [i, owner] of owners.entries()) {
    const site = sites[i]
    if (!site) break
    const isPackage = classifySourcePath(site.loc).origin === 'package'
    if (!isPackage) appOwners += 1
    keptOwners.push(!isPackage && appOwners <= APP_OWNERS_WITH_DATA ? owner : { ...owner, props: null, state: null })
    keptSites.push(site)
    if (appOwners === APP_OWNERS_KEPT) break
  }
  return { owners: keptOwners, callSites: keptSites }
}

export function withSelectedCallSites(
  inspection: Inspection,
  ownerSites: readonly (SourceLoc | null)[],
): { readonly inspection: Inspection; readonly callSites: readonly CallSite[] } {
  if (!inspection.react) return { inspection, callSites: [] }
  const allSites = inspection.react.owners.map((o, i) => ({ name: o.name, loc: ownerSites[i] ?? null }))
  const { owners, callSites } = selectCallSites(inspection.react.owners, allSites)
  return { inspection: { ...inspection, react: { ...inspection.react, owners } }, callSites }
}
