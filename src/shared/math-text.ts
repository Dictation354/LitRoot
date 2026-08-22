export interface PlainMathTextToken {
  kind: 'text'
  value: string
}

export interface FormulaMathTextToken {
  kind: 'math'
  value: string
  raw: string
  display: boolean
}

export type MathTextToken = PlainMathTextToken | FormulaMathTextToken

interface MathDelimiter {
  open: string
  close: string
  display: boolean
  dollar: boolean
}

const DELIMITERS: MathDelimiter[] = [
  { open: '$$', close: '$$', display: true, dollar: true },
  { open: '\\[', close: '\\]', display: true, dollar: false },
  { open: '\\(', close: '\\)', display: false, dollar: false },
  { open: '$', close: '$', display: false, dollar: true }
]

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

function inlineDollarCanOpen(value: string, index: number): boolean {
  const next = value[index + 1]
  if (!next || next === '$' || /\s/u.test(next)) return false

  // Do not interpret monetary identifiers such as `US$5` as TeX. A suffix
  // formula such as `km$^{2}$` is valid and must remain eligible.
  const previous = value[index - 1]
  if (previous && /[\p{L}\p{N}]/u.test(previous) && /\d/u.test(next)) return false

  // A second currency amount later in the sentence can otherwise look like
  // the closing `$` for the first one. Keep common written monetary amounts
  // as prose while still accepting numeric math such as `$0.75 \pm 0.2$`.
  const following = value.slice(index + 1)
  if (
    /^[+-]?\d[\d,.]*(?:[\u00a0\s]+)(?:thousand|million|billion|trillion|dollars?|usd|cad|aud|euros?|yuan|renminbi|pounds?|sterling)\b/iu.test(
      following
    )
  ) {
    return false
  }

  return true
}

function inlineDollarCanClose(value: string, index: number): boolean {
  const previous = value[index - 1]
  return Boolean(previous && previous !== '$' && !/\s/u.test(previous))
}

function delimiterAt(value: string, index: number): MathDelimiter | null {
  if (isEscaped(value, index)) return null

  for (const delimiter of DELIMITERS) {
    if (!value.startsWith(delimiter.open, index)) continue
    if (delimiter.open === '$' && !inlineDollarCanOpen(value, index)) continue
    return delimiter
  }
  return null
}

function closingDelimiterIndex(value: string, start: number, delimiter: MathDelimiter): number {
  for (let index = start; index <= value.length - delimiter.close.length; index += 1) {
    if (!value.startsWith(delimiter.close, index) || isEscaped(value, index)) continue

    if (delimiter.open === '$') {
      if (value[index + 1] === '$' || !inlineDollarCanClose(value, index)) continue
    }
    return index
  }
  return -1
}

function pushText(tokens: MathTextToken[], value: string): void {
  if (!value) return
  const previous = tokens.at(-1)
  if (previous?.kind === 'text') {
    previous.value += value
  } else {
    tokens.push({ kind: 'text', value })
  }
}

/**
 * Split prose into plain-text and TeX tokens without modifying the source.
 * Unmatched or empty delimiters remain plain text so poor source extraction is
 * visible instead of being silently discarded.
 */
export function tokenizeMathText(value: string): MathTextToken[] {
  const tokens: MathTextToken[] = []
  let textStart = 0
  let cursor = 0

  while (cursor < value.length) {
    const delimiter = delimiterAt(value, cursor)
    if (!delimiter) {
      cursor += 1
      continue
    }

    const contentStart = cursor + delimiter.open.length
    const closeIndex = closingDelimiterIndex(value, contentStart, delimiter)
    const content = closeIndex < 0 ? '' : value.slice(contentStart, closeIndex)
    if (closeIndex < 0 || !content.trim()) {
      cursor += delimiter.open.length
      continue
    }

    pushText(tokens, value.slice(textStart, cursor))
    const end = closeIndex + delimiter.close.length
    tokens.push({
      kind: 'math',
      value: content.trim(),
      raw: value.slice(cursor, end),
      display: delimiter.display
    })
    cursor = end
    textStart = end
  }

  pushText(tokens, value.slice(textStart))
  return tokens
}

/** Split Markdown-style paragraphs while keeping multiline display TeX intact. */
export function splitMathTextBlocks(value: string): string[] {
  const blocks: string[] = []
  let current = ''

  const flush = (): void => {
    const block = current.trim()
    if (block) blocks.push(block)
    current = ''
  }

  for (const token of tokenizeMathText(value.replace(/\r\n/g, '\n'))) {
    if (token.kind === 'math') {
      current += token.raw
      continue
    }

    const fragments = token.value.split(/(\n[\t ]*\n(?:[\t ]*\n)*)/u)
    for (const fragment of fragments) {
      if (/^\n[\t ]*\n/u.test(fragment)) {
        flush()
      } else {
        current += fragment
      }
    }
  }
  flush()
  return blocks
}

export function isDisplayMathText(value: string): boolean {
  const tokens = tokenizeMathText(value)
  return tokens.length === 1 && tokens[0]?.kind === 'math' && tokens[0].display
}
