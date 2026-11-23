// Brazilian Portuguese for the "plugins" area (the file list is in i18n/README.md and scripts/i18n-check.mjs).
// Keys are the English text exactly as written in t() / msg(); glossary and rules: ../README.md.
// "YouTube Music" is a product name: not translated.
import type { Dict } from '../core'

export default {
  // ---- PluginsSettings ----
  Plugins: 'Plugins',
  'Admins turn these on or off for everyone.': 'Os admins ativam ou desativam estes recursos para todo mundo.',
  "This server's version has no plugins yet. Update the server to use them.":
    'A versão deste servidor ainda não tem plugins. Atualize o servidor para usar.',
  'Listen together in voice, in sync. Volume is per person, in Audio & video.':
    'Ouçam juntos no canal de voz, em sincronia. O volume é individual, em Áudio e vídeo.',
  Emulator: 'Emulador',
  'Play SNES, Mega Drive, PlayStation and Nintendo 64 games together in a call. Bring your own game files.':
    'Joguem SNES, Mega Drive, PlayStation e Nintendo 64 juntos em uma chamada. Use seus próprios arquivos de jogo.',
} satisfies Dict
