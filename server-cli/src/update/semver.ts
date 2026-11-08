// Tiny semantic-version reader and comparator (https://semver.org §11 precedence), no dependencies.
// Used by `nexo-server update` to pick a newer release and never a downgrade.

export interface Version {
  major: number
  minor: number
  patch: number
  /** Prerelease identifiers: `0.4.0-beta.2` → ['beta', 2]. Empty for a release. */
  pre: (string | number)[]
}

const VERSION_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parses `1.2.3`, `v1.2.3-beta.2`, `1.2.3-rc.1+build`; build metadata is ignored. Null when invalid. */
export function parseVersion(text: string): Version | null {
  const m = VERSION_RE.exec(text.trim())
  if (!m) return null
  const pre = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : []
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre }
}

function compareIds(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b)
  if (typeof a === 'number') return -1 // numeric identifiers have lower precedence than alphanumeric ones
  if (typeof b === 'number') return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Semver precedence: -1 when a < b, 0 when equal, 1 when a > b. Throws on an invalid version. */
export function compareVersions(a: string | Version, b: string | Version): number {
  const va = typeof a === 'string' ? parseVersion(a) : a
  const vb = typeof b === 'string' ? parseVersion(b) : b
  if (!va || !vb) throw new Error(`Not a version: ${!va ? String(a) : String(b)}`)
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (va[k] !== vb[k]) return Math.sign(va[k] - vb[k])
  }
  // A release ranks above its prereleases: 1.0.0-rc.1 < 1.0.0.
  if (!va.pre.length || !vb.pre.length) return va.pre.length === vb.pre.length ? 0 : va.pre.length ? -1 : 1
  for (let i = 0; i < Math.min(va.pre.length, vb.pre.length); i++) {
    const c = compareIds(va.pre[i]!, vb.pre[i]!)
    if (c) return c
  }
  return Math.sign(va.pre.length - vb.pre.length)
}

/**
 * A test build (`0.4.0-test.1`, docs/DEVELOPMENT.md "Test builds"): its own update lane, like the app's
 * updater (electron-updater treats `test` as a channel). Alpha, beta, rc and stable share the other lane.
 */
export function isTestVersion(v: string | Version): boolean {
  const parsed = typeof v === 'string' ? parseVersion(v) : v
  return parsed?.pre[0] === 'test'
}
