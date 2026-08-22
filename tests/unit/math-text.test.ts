import { describe, expect, it } from 'vitest'
import {
  isDisplayMathText,
  splitMathTextBlocks,
  tokenizeMathText
} from '../../src/shared/math-text.js'

describe('tokenizeMathText', () => {
  it('recognizes both inline delimiter forms without changing TeX backslashes', () => {
    expect(tokenizeMathText(String.raw`Phase $t_{IE_m}$ and \(\alpha_{x_i}\).`)).toEqual([
      { kind: 'text', value: 'Phase ' },
      { kind: 'math', value: String.raw`t_{IE_m}`, raw: String.raw`$t_{IE_m}$`, display: false },
      { kind: 'text', value: ' and ' },
      {
        kind: 'math',
        value: String.raw`\alpha_{x_i}`,
        raw: String.raw`\(\alpha_{x_i}\)`,
        display: false
      },
      { kind: 'text', value: '.' }
    ])
  })

  it('recognizes multiline display delimiters and aligned equations', () => {
    const dollar = String.raw`before
$$
\begin{aligned}
x &= \frac{a}{b} \\
y &= \sum_{i=1}^{N} i
\end{aligned}
$$
after`
    const bracket = String.raw`\[\mathbf{x}=\left[x_1,\ldots,x_N\right]\]`

    expect(tokenizeMathText(dollar)[1]).toMatchObject({
      kind: 'math',
      display: true,
      value: expect.stringContaining(String.raw`\frac{a}{b}`)
    })
    expect(tokenizeMathText(bracket)).toEqual([
      {
        kind: 'math',
        value: String.raw`\mathbf{x}=\left[x_1,\ldots,x_N\right]`,
        raw: bracket,
        display: true
      }
    ])
  })

  it('leaves escaped, empty, unmatched, and currency-like delimiters as text', () => {
    const value = String.raw`Cost US$5 or \$6; empty $$ $$; unmatched $x.`
    expect(tokenizeMathText(value)).toEqual([{ kind: 'text', value }])
  })

  it.each([
    '$41 million',
    '$0.7 billion',
    '$3.6 billion … $6.1 billion',
    '$3.6 billion to $6.1 billion'
  ])('does not render the currency string %s as math', (value) => {
    expect(tokenizeMathText(value)).toEqual([{ kind: 'text', value }])
  })

  it('continues to recognize a numeric scientific formula', () => {
    expect(tokenizeMathText(String.raw`Error is $0.75 \pm 0.2$ rad.`)[1]).toEqual({
      kind: 'math',
      value: String.raw`0.75 \pm 0.2`,
      raw: String.raw`$0.75 \pm 0.2$`,
      display: false
    })
  })

  it('recognizes a TeX unit suffix adjacent to ordinary text', () => {
    expect(tokenizeMathText('Spatial extent [km$^{2}$]')[1]).toEqual({
      kind: 'math',
      value: '^{2}',
      raw: '$^{2}$',
      display: false
    })
    expect(tokenizeMathText('Image size [pixel$^{2}$]')[1]).toMatchObject({
      kind: 'math',
      value: '^{2}'
    })
  })

  it('does not treat TeX line-break backslashes before a bracket as a delimiter', () => {
    const value = String.raw`row \\[not display]`
    expect(tokenizeMathText(value)).toEqual([{ kind: 'text', value }])
  })
})

describe('splitMathTextBlocks', () => {
  it('preserves blank lines inside a display equation while splitting prose paragraphs', () => {
    const value = String.raw`First paragraph.

$$
\begin{aligned}
x &= 1 \\

y &= 2
\end{aligned}
$$

Last paragraph.`

    const blocks = splitMathTextBlocks(value)
    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toContain('\n\n')
    expect(isDisplayMathText(blocks[1] ?? '')).toBe(true)
  })
})
