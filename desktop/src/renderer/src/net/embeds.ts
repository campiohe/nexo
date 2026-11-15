// Link previews (GET /api/embed, see shared/protocol.ts). In-memory cache per server (including "no
// preview" answers), request dedupe, a small concurrency limit, and a per-session off switch for servers
// without the endpoint (404). Errors never surface: a link without a preview just shows no card.
import type { Embed } from '@shared/protocol'
import { MAX_EMBEDS_PER_MESSAGE } from '@shared/protocol'
import { parseContent, type Block, type Inline } from '../lib/messageTokens'
import { useApp } from '../store/app'
import { settings } from '../store/settings'

const REQUEST_TIMEOUT_MS = 10_000
/** Transient failures (network, 429, 5xx) are retried after this long. */
const RETRY_AFTER_MS = 60_000
const MAX_CONCURRENT = 4
/** Links looked at per message: previews show for the first MAX_EMBEDS_PER_MESSAGE that have one. */
export const MAX_LINKS_CHECKED = MAX_EMBEDS_PER_MESSAGE * 2
const MAX_CACHE = 2000

type Entry = { embed: Embed | null; until: number }

/** `${serverUrl} ${url}` -> result. `until` = Infinity for permanent answers. */
const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<Embed | null>>()
/** Servers that answered 404 (no embed endpoint): not asked again this session. */
const unsupported = new Set<string>()

let active = 0
const waiting: (() => void)[] = []
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}

const keyOf = (serverUrl: string, url: string) => `${serverUrl} ${url}`

function remember(key: string, embed: Embed | null, transient = false) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string)
  cache.set(key, { embed, until: transient ? Date.now() + RETRY_AFTER_MS : Infinity })
}

/** The cached answer: an Embed, null (no preview), or undefined (unknown: call fetchEmbed). */
export function peekEmbed(url: string): Embed | null | undefined {
  const serverUrl = useApp.getState().serverUrl
  if (!serverUrl) return null
  if (unsupported.has(serverUrl)) return null
  const hit = cache.get(keyOf(serverUrl, url))
  if (!hit || hit.until < Date.now()) return undefined
  return hit.embed
}

function isEmbed(v: unknown): v is Embed {
  if (!v || typeof v !== 'object') return false
  const e = v as Partial<Embed>
  return typeof e.title === 'string' && typeof e.provider === 'string' && (e.url === undefined || typeof e.url === 'string')
}

/** The preview of `url` (null when there's none or it couldn't be fetched). Never rejects. */
export function fetchEmbed(url: string): Promise<Embed | null> {
  const serverUrl = useApp.getState().serverUrl
  if (!serverUrl || unsupported.has(serverUrl)) return Promise.resolve(null)
  const cached = peekEmbed(url)
  if (cached !== undefined) return Promise.resolve(cached)
  const key = keyOf(serverUrl, url)
  const existing = inflight.get(key)
  if (existing) return existing
  const p = slot(() => load(serverUrl, url, key)).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

async function load(serverUrl: string, url: string, key: string): Promise<Embed | null> {
  if (unsupported.has(serverUrl)) return null
  const token = await settings.getToken(serverUrl)
  if (!token) return null
  let res: Response
  try {
    res = await fetch(`${serverUrl}/api/embed?url=${encodeURIComponent(url)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    remember(key, null, true)
    return null
  }
  if (res.status === 404) {
    unsupported.add(serverUrl)
    return null
  }
  if (res.status === 204 || res.status === 400) {
    remember(key, null)
    return null
  }
  if (!res.ok) {
    remember(key, null, true)
    return null
  }
  try {
    const data = (await res.json()) as { embed?: unknown }
    const embed: Embed | null = isEmbed(data?.embed) ? { ...data.embed, url: data.embed.url || url } : null
    // Only https thumbnails (the server promises it; don't trust it blindly).
    if (embed?.thumbnail && !/^https:\/\//i.test(embed.thumbnail.url)) delete embed.thumbnail
    remember(key, embed)
    return embed
  } catch {
    remember(key, null, true)
    return null
  }
}

// ── Links in a message ────────────────────────────────────────────────────────────────────────────────

/**
 * The distinct http(s) links of a message's content, in order, at most `max`. Uses the same parser as
 * MessageContent, so links inside code are never links; links hidden in spoilers are skipped too.
 */
export function messageLinks(content: string, max = MAX_LINKS_CHECKED): string[] {
  if (!content || !/https?:\/\/|www\./i.test(content)) return []
  const out: string[] = []
  const seen = new Set<string>()
  const visitInline = (nodes: Inline[]) => {
    for (const n of nodes) {
      if (out.length >= max) return
      if (n.type === 'link') {
        if (/^https?:\/\//i.test(n.href) && !seen.has(n.href)) {
          seen.add(n.href)
          out.push(n.href)
        }
      } else if (n.type === 'bold' || n.type === 'italic' || n.type === 'underline' || n.type === 'strike') {
        visitInline(n.children)
      }
    }
  }
  const visitBlocks = (blocks: Block[]) => {
    for (const b of blocks) {
      if (out.length >= max) return
      if (b.type === 'paragraph' || b.type === 'heading') visitInline(b.children)
      else if (b.type === 'list') b.items.forEach(visitInline)
      else if (b.type === 'quote') visitBlocks(b.children)
    }
  }
  visitBlocks(parseContent(content).blocks)
  return out
}
