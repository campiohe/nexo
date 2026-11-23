// Settings → Language & time: the app language and the clock format (lib/locale.ts), used by every string src/i18n
// translates and every time lib/time.ts formats. Both apply live: no reload, the voice call stays up.
import { LANGUAGES } from '../../../preload/api'
import { useT } from '../i18n'
import { CLOCK_CHOICES, LANGUAGE_NAMES, resolveLanguage, useLocale, type LanguageChoice } from '../lib/locale'
import { formatTime, useClock } from '../lib/time'

/** 21:05 today: an evening time, so 12-hour and 24-hour read differently. */
function sampleTime(): number {
  const d = new Date()
  d.setHours(21, 5, 0, 0)
  return d.getTime()
}

const LANGUAGE_CHOICES: readonly LanguageChoice[] = ['system', ...LANGUAGES]

function LanguageGroup() {
  const t = useT()
  const choice = useLocale((s) => s.languageChoice)
  const systemName = LANGUAGE_NAMES[resolveLanguage('system')]

  return (
    <div className="appearance-group">
      <span id="language-label" className="field-label">
        {t('Language')}
      </span>
      <div className="vx-seg" role="radiogroup" aria-labelledby="language-label">
        {LANGUAGE_CHOICES.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={choice === id}
            // A language's own name is in that language (read with its pronunciation).
            lang={id === 'system' ? undefined : id}
            className={`vx-seg-btn ${choice === id ? 'is-active' : ''}`}
            onClick={() => useLocale.getState().setLanguage(id)}
          >
            {id === 'system' ? t('System') : LANGUAGE_NAMES[id]}
          </button>
        ))}
      </div>
      <span className="muted small">
        {t.rich('System uses your computer’s language: <lang>{language}</lang>.', {
          language: systemName,
          lang: (c) => <span lang={resolveLanguage('system')}>{c}</span>,
        })}
      </span>
    </div>
  )
}

export function LanguageTimeSection() {
  const t = useT()
  const clock = useClock()

  return (
    <section>
      <h3 className="settings-heading">{t('Language & time')}</h3>

      <LanguageGroup />

      <div className="appearance-group">
        <span id="clock-label" className="field-label">
          {t('Clock')}
        </span>
        <div className="locale-clock-row">
          <div className="vx-seg" role="radiogroup" aria-labelledby="clock-label">
            {CLOCK_CHOICES.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={clock === c.id}
                className={`vx-seg-btn ${clock === c.id ? 'is-active' : ''}`}
                onClick={() => useLocale.getState().setClock(c.id)}
              >
                {t(c.label)}
              </button>
            ))}
          </div>
          <span className="muted small" aria-live="polite">
            {t('Messages show {time}', { time: formatTime(sampleTime(), clock) })}
          </span>
        </div>
        <span className="muted small">{t('Automatic follows your system’s regional format.')}</span>
      </div>
    </section>
  )
}
