// Link previews under a message (net/embeds.ts): provider, author, title link and a thumbnail, with a left
// accent bar in the provider's colour. No inline players (the CSP has frame-src 'none'): the thumbnail's
// play button opens the link in the browser.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Embed } from '@shared/protocol'
import { MAX_EMBEDS_PER_MESSAGE } from '@shared/protocol'
import { fetchEmbed, messageLinks, peekEmbed } from '../net/embeds'
import { openExternal } from '../lib/linkify'
import { useChatPrefs } from '../store/chatPrefs'
import { PlayIcon } from './chatIcons'
import { useT } from '../i18n'
import '../styles/embeds.css'

const PROVIDER_COLORS: Record<string, string> = {
  youtube: '#ff0033',
  twitch: '#9146ff',
  spotify: '#1ed760',
  soundcloud: '#ff5500',
  vimeo: '#1ab7ea',
  reddit: '#ff4500',
  twitter: '#1d9bf0',
  x: '#1d9bf0',
  bluesky: '#1185fe',
  tiktok: '#fe2c55',
  instagram: '#e1306c',
  github: '#8b949e',
  steam: '#66c0f4',
  dailymotion: '#0a7bff',
  bandcamp: '#1da0c3',
  'apple music': '#fa2d48',
  deezer: '#a238ff',
  kick: '#53fc18',
  streamable: '#0f90fa',
}

const providerColor = (provider: string) => PROVIDER_COLORS[provider.trim().toLowerCase()] ?? 'var(--text-2)'

const BIG_THUMB = { w: 400, h: 225 }
const SMALL_THUMB = 80

/**
 * Thumbnail box within BIG_THUMB. Videos are always 16:9 (the image is cropped to it: YouTube's thumbnails
 * are 4:3 with black bars); others keep their own aspect ratio (16:9 when the provider gives no size).
 */
function fitThumb(t: NonNullable<Embed['thumbnail']>, video: boolean): CSSProperties {
  const w = !video && t.width > 0 ? t.width : 16
  const h = !video && t.height > 0 ? t.height : 9
  const scale = Math.min(BIG_THUMB.w / w, BIG_THUMB.h / h)
  return { width: Math.round(w * scale), aspectRatio: `${w} / ${h}` }
}

/** Previews for a message's links; fetched once the message is near the visible part of the list. */
export const MessageEmbeds = memo(function MessageEmbeds({ content }: { content: string }) {
  const enabled = useChatPrefs((s) => s.linkPreviews)
  if (!enabled || !content) return null
  return <EmbedLoader content={content} />
})

function EmbedLoader({ content }: { content: string }) {
  const links = useMemo(() => messageLinks(content), [content])
  if (links.length === 0) return null
  // Remounts when an edit changes the links.
  return <EmbedList key={links.join(' ')} links={links} />
}

function EmbedList({ links }: { links: string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  // Cached answers render at once (no layout shift when scrolling back or switching channels).
  const [results, setResults] = useState<(Embed | null | undefined)[]>(() => links.map((l) => peekEmbed(l)))

  useEffect(() => {
    if (results.every((r) => r !== undefined)) return
    const el = ref.current
    if (!el) return
    let cancelled = false
    const start = () => {
      for (const [i, url] of links.entries()) {
        if (results[i] !== undefined) continue
        void fetchEmbed(url).then((embed) => {
          if (!cancelled) setResults((r) => r.map((x, j) => (j === i ? embed : x)))
        })
      }
    }
    // Only for messages on (or near) screen.
    const root = el.closest('.message-list')
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          start()
        }
      },
      { root, rootMargin: '300px 0px' },
    )
    io.observe(el.closest('.message') ?? el)
    return () => {
      cancelled = true
      io.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const embeds = results.filter((r): r is Embed => !!r).slice(0, MAX_EMBEDS_PER_MESSAGE)

  // A card that appears above the visible part of the list must not push what you're reading down.
  const height = useRef(0)
  useLayoutEffect(() => {
    const el = ref.current
    const list = el?.closest('.message-list')
    if (!el || !list) return
    const h = el.offsetHeight
    const grew = h - height.current
    height.current = h
    if (grew > 0 && el.getBoundingClientRect().bottom <= list.getBoundingClientRect().top + 1) list.scrollTop += grew
  }, [embeds.length])

  return (
    <div className="embeds" ref={ref}>
      {embeds.map((e, i) => (
        <EmbedCard key={`${i} ${e.url}`} embed={e} />
      ))}
    </div>
  )
}

export function EmbedCard({ embed }: { embed: Embed }) {
  const t = useT()
  const [thumbBroken, setThumbBroken] = useState(false)
  const thumb = embed.thumbnail && !thumbBroken ? embed.thumbnail : null
  const big = !!thumb && embed.kind !== 'post'
  const open = () => openExternal(embed.url)
  const style = { '--embed-accent': providerColor(embed.provider) } as CSSProperties
  return (
    <div className={`embed ${big ? 'has-media' : ''}`} style={style}>
      <div className="embed-main">
        <div className="embed-provider">{embed.provider}</div>
        {embed.author && <div className="embed-author">{embed.author}</div>}
        <a
          className="embed-title"
          href={embed.url}
          title={embed.url}
          onClick={(e) => {
            e.preventDefault()
            open()
          }}
          onAuxClick={(e) => {
            e.preventDefault()
            if (e.button === 1) open()
          }}
        >
          {embed.title || embed.url}
        </a>
      </div>
      {thumb && (
        <button
          type="button"
          className={`embed-thumb ${big ? 'is-big' : 'is-small'}`}
          style={big ? fitThumb(thumb, embed.kind === 'video') : { width: SMALL_THUMB, height: SMALL_THUMB }}
          onClick={open}
          title={t('Open in browser: {url}', { url: embed.url })}
          aria-label={
            embed.kind === 'video'
              ? t('Play {title} in the browser', { title: embed.title })
              : t('Open {title} in the browser', { title: embed.title })
          }
        >
          <img
            src={thumb.url}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            referrerPolicy="no-referrer"
            onError={() => setThumbBroken(true)}
          />
          {embed.kind === 'video' && (
            <span className="embed-play" aria-hidden="true">
              <PlayIcon size={22} />
            </span>
          )}
        </button>
      )}
    </div>
  )
}
