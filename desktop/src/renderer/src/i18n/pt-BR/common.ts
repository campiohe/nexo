// Brazilian Portuguese shared by the whole app: dates (lib/time.ts), generic errors (lib/toast.ts).
// Owned by the i18n core: area agents don't edit this file; a generic word they need goes in their own area file
// (the same key may appear in several files, with the same translation). Rules and glossary: ../README.md.
import type { Dict } from '../core'

export default {
  Today: 'Hoje',
  Yesterday: 'Ontem',
  'Something went wrong': 'Algo deu errado',
} satisfies Dict
