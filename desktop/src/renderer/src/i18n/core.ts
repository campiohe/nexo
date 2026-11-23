// Message format: parsing and rendering, with no app state, DOM or React (scripts/i18n-check.mjs loads this file in
// Node to validate the dictionaries). The API the app uses is in ./index.ts; the conventions in ./README.md.
//
// A message is English text (the key) with a small subset of ICU MessageFormat:
//   {name}                                     a value
//   {count, plural, =0 {…} one {…} other {…}}  plural branch by Intl.PluralRules; `#` in a branch is the number
//   {kind, select, voice {…} other {…}}        branch by value
//   <b>…</b>                                   a tag, for t.rich() (plain t() keeps the text inside)
// " // context" at the end of a key tells apart two uses of the same English that translate differently; it is
// never shown. Literal braces can't be written (pass them in a value); "<" is text unless it opens a closed tag.

/** One language's translations, by key (English source text, " // context" included). */
export type Dict = Record<string, string>

/**
 * Marks a string as a message key without translating it, for constants defined at module scope: the label is
 * translated where it is shown, with t(label). The checker finds keys through msg() calls too.
 */
export function msg<S extends string>(source: S): S {
  return source
}

const CONTEXT = ' // '

/** The English text of a key (without its " // context"). */
export function sourceText(key: string): string {
  const i = key.indexOf(CONTEXT)
  return i < 0 ? key : key.slice(0, i)
}

export type MessageNode =
  | string
  | { kind: 'value'; name: string }
  | { kind: 'pound' }
  | { kind: 'plural' | 'select'; name: string; cases: Record<string, MessageNode[]> }
  | { kind: 'tag'; name: string; children: MessageNode[] }

const NAME = /[A-Za-z_][\w]*/y
const SELECTOR = /=\d+|[A-Za-z_][\w-]*/y
const OPEN_TAG = /<([A-Za-z][\w-]*)>/y

class Parser {
  i = 0
  readonly src: string
  constructor(src: string) {
    this.src = src
  }

  fail(what: string): never {
    throw new SyntaxError(`${what} at ${this.i} in ${JSON.stringify(this.src)}`)
  }

  ws(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i++
  }

  match(re: RegExp): RegExpExecArray | null {
    re.lastIndex = this.i
    const m = re.exec(this.src)
    if (m) this.i = re.lastIndex
    return m
  }

  expect(ch: string): void {
    if (this.src[this.i] !== ch) this.fail(`expected "${ch}"`)
    this.i++
  }

  /** Nodes up to the end, a "}" closing a branch (not consumed) or `</endTag>` (consumed). */
  nodes(inPlural: boolean, inBranch: boolean, endTag: string | null): MessageNode[] {
    const out: MessageNode[] = []
    let text = ''
    const flush = (): void => {
      if (text) out.push(text)
      text = ''
    }
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!
      if (ch === '}') {
        if (inBranch) break
        this.fail('unexpected "}"')
      }
      if (ch === '{') {
        flush()
        out.push(this.argument(inPlural))
        continue
      }
      if (ch === '#' && inPlural) {
        flush()
        out.push({ kind: 'pound' })
        this.i++
        continue
      }
      if (ch === '<') {
        if (endTag && this.src.startsWith(`</${endTag}>`, this.i)) {
          flush()
          this.i += endTag.length + 3
          return out
        }
        const start = this.i
        const open = this.match(OPEN_TAG)
        if (open && this.src.indexOf(`</${open[1]}>`, this.i) >= 0) {
          flush()
          out.push({ kind: 'tag', name: open[1]!, children: this.nodes(inPlural, inBranch, open[1]!) })
          continue
        }
        this.i = start
      }
      text += ch
      this.i++
    }
    if (endTag) this.fail(`missing </${endTag}>`)
    flush()
    return out
  }

  argument(inPlural: boolean): MessageNode {
    this.expect('{')
    this.ws()
    const name = this.match(NAME)?.[0] ?? this.fail('expected a value name')
    this.ws()
    if (this.src[this.i] === '}') {
      this.i++
      return { kind: 'value', name }
    }
    this.expect(',')
    this.ws()
    const type = this.match(NAME)?.[0]
    if (type !== 'plural' && type !== 'select') this.fail('expected "plural" or "select"')
    this.ws()
    this.expect(',')
    const cases: Record<string, MessageNode[]> = {}
    for (;;) {
      this.ws()
      if (this.src[this.i] === '}') {
        this.i++
        break
      }
      const selector = this.match(SELECTOR)?.[0] ?? this.fail('expected a case name')
      this.ws()
      this.expect('{')
      cases[selector] = this.nodes(type === 'plural' || inPlural, true, null)
      this.expect('}')
    }
    if (!cases.other) this.fail(`{${name}, ${type}} needs an "other" case`)
    return { kind: type, name, cases }
  }
}

/** Parses a message; throws a SyntaxError on a malformed one. */
export function parseMessage(src: string): MessageNode[] {
  return new Parser(src).nodes(false, false, null)
}

const parsed = new Map<string, MessageNode[]>()

/** parseMessage, cached. A malformed message is shown as plain text (and reported once in the console). */
export function parseCached(src: string): MessageNode[] {
  let nodes = parsed.get(src)
  if (!nodes) {
    try {
      nodes = parseMessage(src)
    } catch (err) {
      console.warn('[nexo] i18n:', err instanceof Error ? err.message : err)
      nodes = [src]
    }
    parsed.set(src, nodes)
  }
  return nodes
}

const pluralRules = new Map<string, Intl.PluralRules>()
const numberFormats = new Map<string, Intl.NumberFormat>()

export function pluralCategory(locale: string, n: number): string {
  let rules = pluralRules.get(locale)
  if (!rules) {
    rules = new Intl.PluralRules(locale)
    pluralRules.set(locale, rules)
  }
  return rules.select(n)
}

export function numberFormat(locale: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = options ? `${locale}|${JSON.stringify(options)}` : locale
  let f = numberFormats.get(key)
  if (!f) {
    f = new Intl.NumberFormat(locale, options)
    numberFormats.set(key, f)
  }
  return f
}

/** Renders a tag's children (rich text); without it a tag renders as its children. */
export type TagRenderer = (name: string, children: unknown[]) => unknown

/**
 * Renders parsed nodes into parts: strings (adjacent ones merged) and, for rich text, whatever the values and the
 * tag renderer return. Numbers are formatted for the locale; a missing value shows as "{name}".
 */
export function renderNodes(
  nodes: readonly MessageNode[],
  locale: string,
  values: Readonly<Record<string, unknown>> | undefined,
  onTag?: TagRenderer,
): unknown[] {
  const walk = (list: readonly MessageNode[], count: number | null, out: unknown[]): unknown[] => {
    const push = (part: unknown): void => {
      if (part === null || part === undefined || part === false || part === '') return
      if (typeof part === 'string' && typeof out[out.length - 1] === 'string') out[out.length - 1] += part
      else out.push(part)
    }
    for (const node of list) {
      if (typeof node === 'string') {
        push(node)
        continue
      }
      switch (node.kind) {
        case 'value': {
          const v = values?.[node.name]
          if (v === undefined) push(`{${node.name}}`)
          else push(typeof v === 'number' ? numberFormat(locale).format(v) : v)
          break
        }
        case 'pound':
          if (count !== null) push(numberFormat(locale).format(count))
          break
        case 'plural': {
          const n = Number(values?.[node.name])
          const branch = node.cases[`=${n}`] ?? (Number.isFinite(n) ? node.cases[pluralCategory(locale, n)] : undefined)
          for (const part of walk(branch ?? node.cases.other!, n, [])) push(part)
          break
        }
        case 'select': {
          const branch = node.cases[String(values?.[node.name])] ?? node.cases.other!
          for (const part of walk(branch, count, [])) push(part)
          break
        }
        case 'tag': {
          const children = walk(node.children, count, [])
          if (onTag) push(onTag(node.name, children))
          else for (const part of children) push(part)
          break
        }
      }
    }
    return out
  }
  return walk(nodes, null, [])
}

/** The value names, plural/select names and tags a message uses (the checker compares source and translation). */
export function messageArguments(nodes: readonly MessageNode[], into = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (typeof node === 'string' || node.kind === 'pound') continue
    if (node.kind === 'tag') {
      into.add(`<${node.name}>`)
      messageArguments(node.children, into)
    } else {
      into.add(`{${node.name}}`)
      if (node.kind !== 'value') for (const branch of Object.values(node.cases)) messageArguments(branch, into)
    }
  }
  return into
}
