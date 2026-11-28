# Translations (i18n)

The app speaks English (the source language) and Brazilian Portuguese (pt-BR). The user picks System, English or
Português (Brasil) in Settings → Language & time; System means pt-BR when the OS's most preferred language is
Portuguese, English otherwise. A change applies live: every component that called `useT()` re-renders, nothing
reloads, the voice call stays up.

- `i18n/index.ts`: the API (`t`, `useT`, `msg`, `tKnown`, `formatNumber`, `formatList`).
- `i18n/core.ts`: the message syntax (parser and renderer, no React, no state).
- `i18n/pt-BR/<area>.ts`: the translations, one file per area of the app (table below), merged automatically.
- `lib/locale.ts`: the language and clock preferences (zustand + localStorage), `<html lang>`, and the report to main.
- `lib/time.ts`: every date and time, in the app language.
- Main process: `src/main/i18n.ts` (`tm()`) + `src/main/i18n-pt-BR.ts` for the tray menu and tooltip, the tray hint,
  update and global-hotkey messages. The renderer tells main the language on start and on every change.

## Keys are the English text

```tsx
t('Upload picture')               // en: "Upload picture"   pt-BR: "Enviar foto"
```

The key is the English string exactly as it appears in the UI. No id to invent, the code stays readable, the
conversion is mechanical, and a missing translation shows the English instead of a key. The price: editing the
English text changes the key, so the pt-BR entry has to be renamed too (`npm run i18n:check` shows it as missing +
unused).

When the same English must translate differently in two places (gender, context), add a context after ` // `. It is
never shown:

```tsx
msg('Off // desktop notifications')   // pt-BR "Desativadas"
msg('Accent // app icon')             // pt-BR "Destaque" (the color picker's "Accent" is "Cor de destaque")
```

## The API

### Components: `useT()`

```tsx
import { useT } from '../i18n'

function Foo({ name, count }: Props) {
  const t = useT() // subscribes: the component re-renders when the language changes
  return (
    <>
      <h3>{t('Members')}</h3>                                               {/* plain */}
      <p>{t('Signed in as {name}', { name })}</p>                           {/* values */}
      <p>{t('{count, plural, one {# member} other {# members}}', { count })}</p>  {/* plural */}
      <p>
        {t.rich('Remove <b>{name}</b> from the server?', { name, b: (c) => <strong>{c}</strong> })}  {/* rich */}
      </p>
      <button aria-label={t('Close')} title={t('Close')} />
    </>
  )
}
```

- `t` from `useT()` changes identity with the language: put it in the deps of a `useMemo` / `useCallback` that builds
  text (e.g. `MessageList`'s `buildRows`, which calls `formatDay`).
- A memoized child (`memo()`) that shows text must call `useT()` itself; text passed down as props is fine.

### Plain modules, event handlers, stores: `t`

```ts
import { t } from '../i18n'

toast(t('Profile picture updated'), 'success')
throw new Error(t('That file is too big (max {size} MB)', { size: 8 }))
```

The exported `t` translates in the language of *now* and doesn't subscribe. Use it for text produced at a moment
(toasts, thrown errors, notifications, `confirm()` text). In a component's render, use `useT()`.

Don't keep translated text in state or a store: keep the data and translate when rendering, or a language change
leaves it stale. Example: `KeybindsSection` stores `{ combo, usedBy }` and renders
`t('{combo} is already used by {action}. Clear it there first.', …)`.

### Constants at module scope: `msg()`

A label in a module-level array or object is evaluated once, at import, before the language is known. Mark it with
`msg()` (returns the string unchanged, lets the checker find the key) and translate where it's shown:

```ts
import { msg } from '../i18n'          // in lib/ files that must stay React-free: '../i18n/core'

export const THEMES = [
  { id: 'dark', label: msg('Dark') },
  { id: 'light', label: msg('Light') },
]
// render: {t(theme.label)}
```

A function that returns a label (like `actionLabel()` in `lib/keybinds.ts`) returns the key; callers write
`t(actionLabel(id))`. A helper that builds a whole sentence can take `t` as a parameter
(`updateStatusLine(t, state)` in `SettingsModal.tsx`).

`t(variable)` only works when the variable holds a key marked with `msg()` somewhere; never pass user content or
server data to `t()`.

### Message syntax

| Syntax | Example |
| --- | --- |
| value | `'Signed in as {name}'` with `{ name }`; numbers are formatted for the language (`1,234` / `1.234`) |
| plural | `'{count, plural, one {# member} other {# members}}'`; `#` is the number. Categories: `one`, `other` (en and pt-BR), exact matches `=0`, `=1`… win. pt-BR counts 0 as `one` ("0 membro"): add `=0 {nenhum membro}` in the translation when it matters |
| select | `'{kind, select, voice {Voice channel} other {Text channel}}'` (needs `other`) |
| rich text | `t.rich('Read the <link>release notes</link>.', { link: (c) => <a href={url}>{c}</a> })`; values may be elements too (`{ name: <strong>{name}</strong> }`). Plain `t()` keeps a tag's text and drops the tag |

Never build a sentence from pieces (`t('Hello') + ' ' + name`, `` `${t('Pinned by')} ${name}` ``): word order differs
between languages. Write the whole sentence with `{values}`. The checker rejects keys built with `+` or `${}`.
Literal `{` `}` can't appear in a message (pass them as a value); `<` is text unless it opens a tag closed later.

### Numbers, lists, dates, sorting

- Dates and times: `lib/time.ts` (`formatTime`, `formatFull`, `formatDay`; components get `clock` from `useClock()`,
  which also re-renders them on a language change). Don't call `toLocaleString` / `Intl.DateTimeFormat` directly.
- `formatNumber(1234.5)`, `formatNumber(0.42, { style: 'percent' })`; `formatList(['Ana', 'Bia', 'Caio'])` →
  "Ana, Bia e Caio". Call them in a component after `useT()` (that's what re-renders it).
- Any other `Intl` / `localeCompare`: pass `t.locale` instead of `undefined`.

### Text from elsewhere: `tKnown()`

Server errors arrive as English text. `tKnown(text)` returns the pt-BR entry with exactly that key, or the text
unchanged, without parsing it. `lib/toast.ts` already applies it to every error it shows (`toast(err, 'error')`);
other places that display a server error (e.g. `connectionError` on the onboarding screen) call it themselves. The
server's strings live in `pt-BR/server.ts`, keyed by the exact text from `server/src` (`fail(ack, '…')`,
`*_ERRORS`).

## What to translate

Translate everything a user reads or hears: JSX text, `title`, `placeholder`, `alt`, **`aria-label` and other aria
text**, toasts, thrown errors that end up in a toast, native notification text sent to main, `confirm()` text,
document titles.

Don't translate:

- user content: messages, names, channel and server names, custom statuses, sound names, game names;
- product and proper names: Nexo, Chromium, YouTube Music, GitHub, Windows, the emulator's system names (SNES,
  Mega Drive…), codec / GPU names;
- key names in keybinds (`Ctrl+Shift+M`, `Mouse 4`, `Esc`, `Backspace`: in a sentence they're plain text, keep them);
- console and log lines (`console.warn('[nexo] …')`), protocol values, ids, CSS classes, localStorage keys, URLs;
- emoji search keywords.

## Style

- English: sentence case, short, no em dashes (use a period, colon or parentheses), "…" (one character) for
  in-progress text, typographic apostrophe where the source already has one.
- pt-BR: natural Brazilian Portuguese as friends who game talk: informal "você", short, direct. Keep the English
  terms Brazilian gamers actually use (stream, chat, app, build, link, plugin, emoji, FPS, encoder). Same punctuation
  and "…" as the source. Avoid gendered adjectives about the user when a neutral phrasing exists ("Sua sessão
  continua ativa" rather than "Você continua conectado"); for states, prefer nouns ("microfone desativado").
- A translation must use the same `{values}` and `<tags>` as its key (the checker enforces it).

## Glossary (pt-BR)

| English | pt-BR |
| --- | --- |
| server | servidor |
| channel / text channel / voice channel | canal / canal de texto / canal de voz |
| voice (being in voice), call | canal de voz, chamada ("in voice" → "em um canal de voz", "leaves the call" → "sai da chamada") |
| join / leave (voice) | entrar / sair ("Leave voice" → "Sair do canal de voz") |
| disconnect | desconectar |
| mute / unmute | silenciar / ativar microfone (state: "microfone desativado") |
| deafen / undeafen | desativar áudio / ativar áudio (state: "áudio desativado") |
| toggle mute / deafen | ativar/desativar microfone / ativar/desativar áudio |
| push to talk | pressione para falar |
| stream (noun) / to stream / go live | transmissão / transmitir / transmitir |
| share screen, share picker | compartilhar tela, escolha do que compartilhar |
| viewer | espectador |
| soundboard / sound | painel de sons / som |
| wake up (nudge a muted user) | acordar ("Wake up {name}" → "Acordar {name}"; "{name} woke you up" → "{name} te acordou"). Prefer the verb; no noun |
| mention / mentioned | menção / mencionar ("when you're mentioned" → "quando mencionarem você") |
| unread | não lida(s) |
| pin / unpin / pinned messages | fixar / desafixar / mensagens fixadas |
| reply / react / reaction | responder / reagir / reação |
| edit / delete (a message) | editar / excluir |
| attachment / upload / download | anexo / enviar / baixar |
| link preview | prévia de link |
| plugin / emulator / music | plugin / emulador / música (queue: fila, track: faixa, playlist: playlist) |
| owner / admin / member | dono / admin / membro |
| role, permission | cargo, permissão |
| invite (noun / verb) | convite / convidar |
| sign in / sign-in request / approve | entrar / pedido de acesso / aprovar |
| log out | sair ("Log out of this device" → "Sair neste dispositivo") |
| device / this device | dispositivo / este dispositivo |
| profile / profile picture / avatar / banner | perfil / foto de perfil / avatar / banner |
| status: online / idle / do not disturb / invisible | online / ausente / não perturbe / invisível |
| custom status / activity / playing {game} | status personalizado / atividade / jogando {game} |
| settings / keybinds / shortcut | configurações / atalhos / atalho |
| notifications / desktop notifications | notificações / notificações na área de trabalho |
| quick switcher / jump to a channel | troca rápida / ir para um canal |
| search | buscar / busca |
| system tray | bandeja do sistema (short: bandeja) |
| update / restart to update / test build | atualização / reiniciar para atualizar / build de teste |
| input / output device, microphone, headphones | dispositivo de entrada / saída, microfone, fones |
| noise suppression / echo cancellation | supressão de ruído / cancelamento de eco |
| volume / sound effects | volume / efeitos sonoros |
| typing | digitando ("{name} is typing…" → "{name} está digitando…") |

## Where the pt-BR entries go

Add each translation to the area file of the source file that uses it. A generic word ("Cancel", "Save") goes in your
own area file too, even if another area has it: the same key may appear in several files as long as the translation
is identical (the checker flags a difference). `common.ts` belongs to the i18n core.

| Area file | Source files (paths under `src/renderer/src`) |
| --- | --- |
| `common.ts` | `lib/time.ts`, `lib/toast.ts`, `i18n/` |
| `settings.ts` | `components/SettingsModal.tsx`, `LanguageSettings.tsx`, `AppearanceSettings.tsx`, `AccentPicker.tsx`; `lib/appearance.ts`, `lib/appIcon.ts`, `lib/locale.ts`, `lib/keybinds.ts` |
| `shell.ts` | `App.tsx`, `main.tsx`, `components/TitleBar`, `MainLayout`, `Sidebar`, `QuickSwitcher`, `Toasts`, `UpdateBanner`, `Splash`, `Modal`, `Floating`, `icons.tsx`; `lib/updates.ts`, `lib/notify.ts`, `lib/url.ts`; `store/ui.ts`, `store/unread.ts`, `store/settings.ts` |
| `accounts.ts` | `components/Onboarding`, `SignInSteps`, `AccessRequestBanners`; `store/app.ts`, `store/admin.ts`, `store/signin.ts`, `store/logins.ts`; `net/accounts.ts`, `net/socket.ts`; `lib/permissions.ts` |
| `people.ts` | `components/MemberList`, `MembersSection`, `ProfileCard`, `ProfileBanner`, `BannerSettings`, `StatusMenu`, `ActivitySettings`, `Avatar`, `AvatarCropDialog`, `ColorSwatches`, `peopleIcons`; `store/presence.ts`; `lib/presenceSync.ts`, `lib/activity.ts`, `lib/avatar*.ts`, `lib/gif*.ts`, `lib/imageCrop.ts`, `lib/imageEncode.ts`, `lib/colors.ts`, `lib/idleAnimations.ts`; `net/avatar.ts`, `net/banner.ts` |
| `plugins.ts` | `components/PluginsSettings.tsx`, `store/plugins.ts` |
| `music.ts` | `components/voice/Music*.tsx`, `components/voice/musicIcons.tsx`, `voice/music*.ts`, `store/music.ts` |
| `emulator.ts` | `components/emulator/`, `emulator/` (not `emulator/engine/`), `store/emulator.ts` |
| `voice.ts` | the rest of `components/voice/` and `voice/`, `store/sounds.ts`, `net/sounds.ts` |
| `chat.ts` | `components/TextChannel`, `Message*`, `PanelMessage`, `PinsPanel`, `Composer`, `AutocompletePopup`, `EmojiPicker`, `Reactions`, `EmbedCard`, `ImageLightbox`, `Search*`, `TypingLine`, `chatIcons`; `lib/messageTokens.ts`, `lib/mentions.ts`, `lib/searchQuery.ts`, `lib/linkify.ts`, `lib/highlight.ts`, `lib/emoji*.ts`; `net/attachments.ts`, `net/embeds.ts`; `store/compose.ts`, `store/chatPanels.ts`, `store/chatPrefs.ts` |
| `server.ts` | not code: the server's English messages, by exact text (`tKnown`) |

The same table is `AREAS` in `desktop/scripts/i18n-check.mjs`; a new source file goes in both. Group entries by
component with a `// ---- Name ----` comment, in the order they appear.

## Checking

```sh
npm run i18n:check -w desktop                 # missing pt-BR per area, unused keys, errors (also main's tm())
npm run i18n:check -w desktop -- --todo=chat  # strings in an area (or path prefix) that look unwrapped
npm run i18n:check -w desktop -- --strict     # exit 1 when anything is missing (CI)
```

Errors (exit 1): a message that doesn't parse, a translation whose `{values}` / `<tags>` differ from its key's, a key
translated differently in two files, a key built with `+` or `${}`. `--todo` is a heuristic: add `// i18n-ignore` at
the end of a line it flags wrongly. Keys are found in `t('…')`, `t.rich('…')` and `msg('…')` with a literal first
argument, so always write the literal in the call (or in a `msg()`).

Before you're done with an area: `npm run typecheck -w desktop`, `npm run i18n:check -w desktop` (0 missing in your
area, 0 errors), and `--todo=<area>` shows only false positives.
