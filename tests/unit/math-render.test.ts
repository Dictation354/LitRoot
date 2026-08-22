import { describe, expect, it } from 'vitest'
import { renderMathTokenToHtml } from '../../src/shared/math-render.js'
import type { FormulaMathTextToken } from '../../src/shared/math-text.js'

function formula(value: string, display = false): FormulaMathTextToken {
  const delimiter = display ? '$$' : '$'
  return { kind: 'math', value, raw: `${delimiter}${value}${delimiter}`, display }
}

describe('renderMathTokenToHtml', () => {
  it('renders inline and display TeX as accessible KaTeX markup', () => {
    const inline = renderMathTokenToHtml(formula(String.raw`\alpha_{x_i}`)) ?? ''
    const display =
      renderMathTokenToHtml(formula(String.raw`\frac{4\pi}{\lambda}.\tag{3}`, true)) ?? ''

    expect(inline).toContain('class="katex"')
    expect(inline).toContain('<math')
    expect(display).toContain('class="katex-display"')
    expect(display).toContain('<math')
  })

  it('does not enable trusted KaTeX URL commands from research text', () => {
    expect(
      renderMathTokenToHtml(formula(String.raw`\href{javascript:alert(1)}{unsafe}`))
    ).toBeNull()
    expect(renderMathTokenToHtml(formula(String.raw`\url{https://example.test}`))).toBeNull()
    expect(renderMathTokenToHtml(formula(String.raw`\includegraphics{x.png}`))).toBeNull()
    expect(renderMathTokenToHtml(formula(String.raw`\htmlClass{x}{unsafe}`))).toBeNull()
  })

  it('renders unit suffix formulas', () => {
    const markup = renderMathTokenToHtml(formula('^{2}')) ?? ''

    expect(markup).toContain('class="katex"')
    expect(markup).toContain('<msup>')
  })

  it('returns null for malformed or excessively long TeX', () => {
    expect(renderMathTokenToHtml(formula(String.raw`\frac{`))).toBeNull()
    expect(renderMathTokenToHtml(formula('x'.repeat(20_001)))).toBeNull()
  })
})
