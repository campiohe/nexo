import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useApp } from '../store/app'
import { settings } from '../store/settings'
import { SWATCHES, randomSwatch } from '../lib/colors'
import { DEFAULT_SERVER_URL, isValidServerUrl, normalizeServerUrl } from '../lib/url'
import { Avatar } from './Avatar'
import { ColorSwatches } from './ColorSwatches'
import { AlertIcon, ChevronIcon, NexoMark } from './icons'

const NAME_RE = /^[\p{L}\p{M}\p{N}_.\- ]{2,24}$/u

export function Onboarding() {
  const connection = useApp((s) => s.connection)
  const connectionError = useApp((s) => s.connectionError)
  const notice = useApp((s) => s.onboardingNotice)
  const join = useApp((s) => s.join)

  const [serverUrl, setServerUrl] = useState(() => useApp.getState().serverUrl ?? settings.getServerUrl() ?? DEFAULT_SERVER_URL)
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(() => randomSwatch())
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  const busy = submitted && connection === 'connecting'
  const serverError = submitted && connection === 'error' ? connectionError : null
  const error = localError ?? serverError
  const wrongPassword = !!serverError && /password/i.test(serverError)
  const nameTaken = !!serverError && /name/i.test(serverError)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  useEffect(() => {
    if (wrongPassword) {
      setShowPassword(true)
      requestAnimationFrame(() => passwordRef.current?.focus())
    } else if (nameTaken) {
      nameRef.current?.select()
    }
  }, [wrongPassword, nameTaken, serverError])

  function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const url = normalizeServerUrl(serverUrl)
    const cleanName = name.trim().replace(/\s+/g, ' ')
    if (!isValidServerUrl(url)) return setLocalError('Enter a valid server address, like http://100.64.0.1:3001')
    if (!NAME_RE.test(cleanName)) return setLocalError('Names must be 2–24 letters, numbers, spaces, . _ or -')
    setLocalError(null)
    setServerUrl(url)
    setName(cleanName)
    setSubmitted(true)
    join({ serverUrl: url, name: cleanName, color, password: password || undefined })
  }

  return (
    <div className="onboarding">
      <div className="onboarding-glow" aria-hidden="true" />
      <form className="onboarding-card" onSubmit={submit} noValidate>
        <div className="onboarding-brand">
          <NexoMark size={40} />
          <div>
            <h1>Welcome to Nexo</h1>
            <p className="muted">Pick a name and a color. This device will remember you.</p>
          </div>
        </div>

        {notice && (
          <div className="callout callout-warn">
            <AlertIcon size={16} />
            <span>{notice}</span>
          </div>
        )}

        <label className="field">
          <span className="field-label">Server address</span>
          <input
            className="input"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            onBlur={() => serverUrl.trim() && setServerUrl(normalizeServerUrl(serverUrl))}
            placeholder={DEFAULT_SERVER_URL}
            spellCheck={false}
            autoComplete="url"
            disabled={busy}
          />
          <span className="field-hint">Ask the person hosting the server for this.</span>
        </label>

        <div className="onboarding-identity">
          <Avatar user={{ name: name.trim() || '?', color }} size={56} />
          <label className="field grow">
            <span className="field-label">Display name</span>
            <input
              ref={nameRef}
              className={`input ${nameTaken ? 'input-invalid' : ''}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ana"
              maxLength={24}
              spellCheck={false}
              autoComplete="nickname"
              disabled={busy}
            />
          </label>
        </div>

        <div className="field">
          <span className="field-label">Color</span>
          <ColorSwatches value={color} onChange={setColor} colors={SWATCHES} disabled={busy} />
        </div>

        <div className={`collapsible ${showPassword ? 'is-open' : ''}`}>
          <button type="button" className="collapsible-toggle" onClick={() => setShowPassword((v) => !v)} aria-expanded={showPassword}>
            <ChevronIcon size={14} className="collapsible-chevron" />
            Server password <span className="muted">(only if the host set one)</span>
          </button>
          {showPassword && (
            <input
              ref={passwordRef}
              className={`input ${wrongPassword ? 'input-invalid' : ''}`}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Server password"
              autoComplete="current-password"
              disabled={busy}
            />
          )}
        </div>

        {error && (
          <div className="callout callout-error" role="alert">
            <AlertIcon size={16} />
            <span>{error}</span>
          </div>
        )}

        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
          {busy ? (
            <>
              <span className="spinner" /> Connecting…
            </>
          ) : (
            'Join server'
          )}
        </button>
      </form>
    </div>
  )
}
