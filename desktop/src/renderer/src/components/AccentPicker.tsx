// Settings → Appearance: the custom accent swatch (after the presets) and its color picker, a saturation / brightness
// area, a hue slider and a hex field in a popover. Not <input type="color">: on Windows that opens the Win32 dialog.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import { Floating } from './Floating'
import { PlusIcon } from './icons'
import { deriveAccent, hexToHsv, hsvToHex, parseHex, type Hsv } from '../lib/accentColor'
import { CUSTOM_ACCENT_LABEL, useAppearance } from '../lib/appearance'
import { formatNumber, useT } from '../i18n'
import type { AnchorRect } from '../store/ui'

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const percent = (v: number) => formatNumber(v, { style: 'percent', maximumFractionDigits: 0 })

/** The page's current accent shade, where the picker starts before a custom color exists. */
function currentAccent(): string {
  return parseHex(getComputedStyle(document.documentElement).getPropertyValue('--accent')) ?? '#43d6a3'
}

/** Pointer drag inside an element: `onMove` gets the position as fractions (0…1) of its box, on press and while held. */
function dragHandlers(onMove: (x: number, y: number) => void) {
  const move = (e: PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    onMove(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height))
  }
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      e.preventDefault() // no text selection while dragging; focus by hand instead
      e.currentTarget.focus({ preventScroll: true })
      e.currentTarget.setPointerCapture(e.pointerId)
      move(e)
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e)
    },
  }
}

/** Arrow-key step: 1%, or 10% with Shift. */
const step = (e: KeyboardEvent) => (e.shiftKey ? 0.1 : 0.01)

function ColorPicker({ value, onChange, autoFocus }: { value: string; onChange(hex: string): void; autoFocus: boolean }) {
  const t = useT()
  // HSV is the picker's own state: the hue survives dragging to gray or black, which the hex can't hold.
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value))
  const [text, setText] = useState(value.slice(1))
  const svRef = useRef<HTMLDivElement>(null)

  // A new value from outside the area / slider (hex field, store): follow it.
  useEffect(() => {
    setHsv((cur) => (hsvToHex(cur) === value ? cur : hexToHsv(value)))
    setText((cur) => (parseHex(cur) === value ? cur : value.slice(1)))
  }, [value])

  useEffect(() => {
    if (autoFocus) svRef.current?.focus({ preventScroll: true })
  }, [autoFocus])

  const update = (next: Hsv) => {
    setHsv(next)
    onChange(hsvToHex(next))
  }

  const sv = dragHandlers((x, y) => update({ ...hsv, s: x, v: 1 - y }))
  const hue = dragHandlers((x) => update({ ...hsv, h: x * 360 }))

  const onSvKey = (e: KeyboardEvent) => {
    const d = step(e)
    const next =
      e.key === 'ArrowLeft' ? { s: hsv.s - d } :
      e.key === 'ArrowRight' ? { s: hsv.s + d } :
      e.key === 'ArrowDown' ? { v: hsv.v - d } :
      e.key === 'ArrowUp' ? { v: hsv.v + d } : null
    if (!next) return
    e.preventDefault()
    update({ ...hsv, s: clamp01(next.s ?? hsv.s), v: clamp01(next.v ?? hsv.v) })
  }

  const onHueKey = (e: KeyboardEvent) => {
    const d = e.shiftKey ? 10 : 1
    const h =
      e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? hsv.h - d :
      e.key === 'ArrowRight' || e.key === 'ArrowUp' ? hsv.h + d :
      e.key === 'Home' ? 0 :
      e.key === 'End' ? 360 : null
    if (h === null) return
    e.preventDefault()
    update({ ...hsv, h: Math.min(360, Math.max(0, h)) })
  }

  const pureHue = hsvToHex({ h: hsv.h, s: 1, v: 1 })
  return (
    <div className="cp">
      <div
        ref={svRef}
        className="cp-sv"
        style={{ '--cp-hue': pureHue } as CSSProperties}
        role="slider"
        tabIndex={0}
        aria-label={t('Saturation and brightness')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={t('Saturation {saturation}, brightness {brightness}', {
          saturation: percent(hsv.s),
          brightness: percent(hsv.v),
        })}
        onKeyDown={onSvKey}
        {...sv}
      >
        <span className="cp-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: value }} />
      </div>
      <div
        className="cp-hue"
        role="slider"
        tabIndex={0}
        aria-label={t('Hue')}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        onKeyDown={onHueKey}
        {...hue}
      >
        <span className="cp-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, background: pureHue }} />
      </div>
      <label className="cp-hex">
        <span className="cp-hex-hash" aria-hidden="true">
          #
        </span>
        <input
          className="input"
          value={text}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('Hex color')}
          onChange={(e) => {
            const v = e.target.value.replace(/^#/, '')
            setText(v)
            const hex = parseHex(v)
            if (hex) onChange(hex)
          }}
          onBlur={() => setText(value.slice(1))}
        />
      </label>
    </div>
  )
}

/** The 7th accent swatch: the custom color (empty with a "+" until one is picked), opening the picker. */
export function CustomAccentSwatch() {
  const t = useT()
  const selected = useAppearance((s) => s.accent === 'custom')
  const custom = useAppearance((s) => s.customAccent)
  const resolved = useAppearance((s) => s.resolved)
  const shades = useMemo(() => (custom ? deriveAccent(custom) : null), [custom])
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  /** Opened from the keyboard: focus moves into the picker. */
  const [keyboard, setKeyboard] = useState(false)
  const [start, setStart] = useState('#43d6a3')
  const closedAt = useRef(0)

  const close = () => {
    closedAt.current = Date.now()
    // Escape (focus inside the picker): back to the swatch. An outside click keeps the focus it gave.
    if (popoverRef.current?.contains(document.activeElement)) buttonRef.current?.focus({ preventScroll: true })
    setAnchor(null)
  }

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    // Enter / Space while open: close. (A mouse press closes it on pointerdown, before this click.)
    if (anchor) return close()
    // The press that closed the picker (outside it) shouldn't reopen it.
    if (Date.now() - closedAt.current < 300) return
    const appearance = useAppearance.getState()
    if (custom) appearance.setAccent('custom')
    else setStart(currentAccent())
    const r = e.currentTarget.getBoundingClientRect()
    setKeyboard(e.detail === 0)
    setAnchor({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
  }

  const label = t(CUSTOM_ACCENT_LABEL)
  // The shade this palette shows; when it isn't the picked color, say why.
  const shown = shades ? (resolved === 'light' ? shades.accentL : shades.accentD) : null
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        role="radio"
        aria-checked={selected}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        aria-label={label}
        title={label}
        data-accent="custom"
        className={`swatch accent-swatch ${shades ? '' : 'is-empty'} ${selected ? 'is-selected' : ''}`}
        style={shades ? ({ '--accent-d': shades.accentD, '--accent-l': shades.accentL } as CSSProperties) : undefined}
        onClick={onClick}
      >
        {!shades && <PlusIcon size={14} />}
      </button>
      {anchor && (
        <Floating anchor={anchor} side="bottom" onClose={close} className="accent-picker" label={t('Custom accent color')}>
          <div ref={popoverRef}>
            <ColorPicker
              value={custom ?? start}
              onChange={(hex) => useAppearance.getState().setCustomAccent(hex)}
              autoFocus={keyboard}
            />
            {custom && shown !== custom && (
              <p className="cp-note">
                {resolved === 'light'
                  ? t('Shown darker in the light theme so it stays readable.')
                  : t('Shown lighter in dark themes so it stays readable.')}
              </p>
            )}
          </div>
        </Floating>
      )}
    </>
  )
}
