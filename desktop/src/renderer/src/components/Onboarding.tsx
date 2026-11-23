import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useApp } from '../store/app'
import { settings } from '../store/settings'
import { findLogin, NOTICE_UNREADABLE, resumeLogin, startAccessRequest, useSignIn } from '../store/signin'
import { errorMessage } from '../lib/toast'
import { SWATCHES, randomSwatch } from '../lib/colors'
import { DEFAULT_SERVER_URL, isValidServerUrl, normalizeServerUrl } from '../lib/url'
import { Avatar } from './Avatar'
import { ColorSwatches } from './ColorSwatches'
import { AlertIcon, NexoMark } from './icons'
import { AccessRequestStep, WelcomeBackStep } from './SignInSteps'
import { tKnown, useT } from '../i18n'

const NAME_RE = /^[\p{L}\p{M}\p{N}_.\- ]{2,24}$/u

export function Onboarding() {
  const t = useT()
  const connection = useApp((s) => s.connection)
  const connectionError = useApp((s) => s.connectionError)
  const notice = useApp((s) => s.onboardingNotice)
  const join = useApp((s) => s.join)
  const welcome = useSignIn((s) => s.welcome)
  const accessRequest = useSignIn((s) => s.request)

  const [serverUrl, setServerUrl] = useState(() => useApp.getState().serverUrl ?? settings.getServerUrl() ?? DEFAULT_SERVER_URL)
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(() => randomSwatch())
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  /** Translated where shown: a message key from this form, or an error message already in the app language. */
  const [localError, setLocalError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  /** Checking the server for a saved login / "Welcome back" accounts before creating an account. */
  const [probing, setProbing] = useState(false)
  const [requesting, setRequesting] = useState(false)
  /** The name last sent to the server (what "This is my account" asks for). */
  const [submittedName, setSubmittedName] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  const busy = probing || requesting || (submitted && connection === 'connecting')
  const serverError = submitted && connection === 'error' ? connectionError : null
  // The server's messages arrive in English (pt-BR/server.ts); the regexes below test that English.
  const error = localError ?? (serverError && tKnown(serverError))
  const wrongPassword = !!serverError && /password/i.test(serverError)
  const nameTaken = !!serverError && /name/i.test(serverError)
  /** "That name is already taken": offer a sign-in request for that account. */
  const canRequestAccess = !!serverError && /taken/i.test(serverError)

  // Also when coming back to the form from the "Welcome back" or sign-in request step.
  useEffect(() => {
    nameRef.current?.focus()
  }, [welcome, accessRequest])

  useEffect(() => {
    if (wrongPassword) {
      setShowPassword(true)
      requestAnimationFrame(() => passwordRef.current?.focus())
    } else if (nameTaken) {
      nameRef.current?.select()
    }
  }, [wrongPassword, nameTaken, serverError])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const url = normalizeServerUrl(serverUrl)
    const cleanName = name.trim().replace(/\s+/g, ' ')
    if (!isValidServerUrl(url)) return setLocalError(t('Enter a valid server address, like {example}', { example: 'http://100.64.0.1:3001' }))
    if (!NAME_RE.test(cleanName)) return setLocalError(t('Names must be 2–24 letters, numbers, spaces, . _ or -'))
    setLocalError(null)
    setServerUrl(url)
    setName(cleanName)

    // First time on this server address: look for a saved login (maybe under another address) and for
    // accounts this device is linked to, before creating a new account.
    if (useSignIn.getState().probedUrl !== url) {
      setSubmitted(false)
      setProbing(true)
      const found = await findLogin(url).finally(() => setProbing(false))
      if (found.token) return resumeLogin(url, found.token)
      // Warn once; submitting again goes ahead.
      if (found.unreadable && useApp.getState().onboardingNotice !== NOTICE_UNREADABLE) {
        return useApp.setState({ onboardingNotice: NOTICE_UNREADABLE })
      }
      if (useSignIn.getState().welcome) return // "Welcome back" step
    }
    setSubmitted(true)
    setSubmittedName(cleanName)
    join({ serverUrl: url, name: cleanName, color, password: password || undefined })
  }

  async function requestAccess() {
    if (busy) return
    // The server that said the name is taken (connect() recorded it), not whatever the field says now.
    const url = useApp.getState().serverUrl ?? normalizeServerUrl(serverUrl)
    setLocalError(null)
    setRequesting(true)
    try {
      await startAccessRequest(url, submittedName, password || undefined)
    } catch (err) {
      setLocalError(errorMessage(err))
    } finally {
      setRequesting(false)
    }
  }

  if (accessRequest || welcome) {
    return (
      <div className="onboarding">
        {accessRequest ? (
          <AccessRequestStep request={accessRequest} />
        ) : (
          welcome && <WelcomeBackStep serverUrl={welcome.serverUrl} accounts={welcome.accounts} />
        )}
      </div>
    )
  }

  return (
    <div className="onboarding">
      <form className="onboarding-card" onSubmit={(e) => void submit(e)} noValidate>
        <div className="onboarding-brand">
          <NexoMark size={36} tile />
          <h1>{t('Join a server')}</h1>
          <p className="muted">{t('Ask whoever runs it for the address.')}</p>
        </div>

        {notice && (
          <div className="callout callout-warn">
            <AlertIcon size={16} />
            <span>{tKnown(notice)}</span>
          </div>
        )}

        <label className="field">
          <span className="field-label">{t('Server address')}</span>
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
        </label>

        <div className="onboarding-identity">
          <Avatar user={{ name: name.trim() || '?', color }} size={40} />
          <label className="field grow">
            <span className="field-label">{t('Your name')}</span>
            <input
              ref={nameRef}
              className={`input ${nameTaken ? 'input-invalid' : ''}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('e.g. Ana')}
              maxLength={24}
              spellCheck={false}
              autoComplete="nickname"
              disabled={busy}
            />
          </label>
        </div>

        <div className="field">
          <span className="field-label">{t('Color')}</span>
          <ColorSwatches value={color} onChange={setColor} colors={SWATCHES} disabled={busy} />
        </div>

        {showPassword ? (
          <label className="field">
            <span className="field-label">{t('Server password')}</span>
            <input
              ref={passwordRef}
              className={`input ${wrongPassword ? 'input-invalid' : ''}`}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
            />
          </label>
        ) : (
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setShowPassword(true)
              requestAnimationFrame(() => passwordRef.current?.focus())
            }}
          >
            {t('The server has a password')}
          </button>
        )}

        {error && (
          <div className="callout callout-error" role="alert">
            <AlertIcon size={16} />
            <span>{error}</span>
          </div>
        )}

        {canRequestAccess && (
          <div className="onboarding-claim">
            <span>
              {t.rich('Is <b>{name}</b> you, on another device?', { name: submittedName, b: (c) => <strong>{c}</strong> })}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void requestAccess()} disabled={busy}>
              {requesting ? (
                <>
                  <span className="spinner" /> {t('Sending…')}
                </>
              ) : (
                t('This is my account')
              )}
            </button>
          </div>
        )}

        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
          {busy && !requesting ? (
            <>
              <span className="spinner" /> {t('Connecting…')}
            </>
          ) : (
            t('Join')
          )}
        </button>
      </form>
    </div>
  )
}
