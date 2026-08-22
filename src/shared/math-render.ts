import { renderToString } from 'katex'
import type { FormulaMathTextToken } from './math-text.js'

export const MAX_FORMULA_CHARACTERS = 20_000
const TRUST_DEPENDENT_COMMAND =
  /\\(?:href|url|includegraphics|html(?:Class|Id|Style|Data))\b/u

export function isSafeMathSource(value: string): boolean {
  return value.length <= MAX_FORMULA_CHARACTERS && !TRUST_DEPENDENT_COMMAND.test(value)
}

/** Render one already-delimited formula, or return null for a safe raw fallback. */
export function renderMathTokenToHtml(token: FormulaMathTextToken): string | null {
  if (!isSafeMathSource(token.value)) {
    return null
  }

  try {
    return renderToString(token.value, {
      displayMode: token.display,
      output: 'htmlAndMathml',
      throwOnError: true,
      strict: 'ignore',
      trust: false,
      maxSize: 20,
      maxExpand: 1_000
    })
  } catch {
    return null
  }
}
