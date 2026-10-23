import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { TeX } from '@mathjax/src/js/input/tex.js'
import { SVG } from '@mathjax/src/js/output/svg.js'
import { createMathRenderer, mathjaxExtensions, mathjaxVersion } from '../../src/shared/markdown-math.mjs'

describe('shared offline MathJax renderer', () => {
  it('pins the engine and preloaded extension contract without error masking packages', () => {
    expect(mathjaxVersion).toBe('4.1.3')
    expect(mathjaxExtensions).toEqual([
      'base', 'ams', 'amscd', 'newcommand', 'configmacros', 'textmacros',
      'boldsymbol', 'mathtools', 'mhchem', 'upgreek', 'unicode', 'bbox',
      'braket', 'cancel', 'color', 'enclose', 'extpfeil', 'verb', 'cases', 'bbm', 'textcomp'
    ])
  })

  it('keeps the generated paper-fetch engine byte-for-byte', () => {
    const engine = readFileSync(new URL('../../src/shared/markdown-math.mjs', import.meta.url))
    const digest = readFileSync(new URL('../../src/shared/markdown-math.sha256', import.meta.url), 'utf8').trim()
    expect(createHash('sha256').update(engine).digest('hex')).toBe(digest)
  })

  it.each([
    String.raw`m\overset{\lower0.2em\hbox{$\smash{\scriptscriptstyle\rightharpoonup}$}} {g}`,
    String.raw`\begin{align}x&=1\\ y&=2\end{align}`,
    String.raw`\begin{CD}A @>f>> B\\ @VgVV @VVhV \\ C @>>k> D\end{CD}`,
    String.raw`\text{a \textbf{bold} \emph{text}}`,
    String.raw`\boldsymbol{\alpha}`,
    String.raw`\mathbbm{1} + \mathbbmss{R} + \mathbbmtt{N}`,
    String.raw`\textdegree + \textmu`,
    String.raw`x\coloneqq\begin{dcases}1&x>0\\0&x=0\end{dcases}`,
    String.raw`\ce{2H2 + O2 -> 2H2O}`,
    String.raw`\upalpha + \unicode{x2605}`,
    String.raw`\bbox[red,2px]{x}`,
    String.raw`\Braket{x|y}`,
    String.raw`\cancel{x}`,
    String.raw`\color{red}{x}`,
    String.raw`\enclose{circle}{x}`,
    String.raw`\xtwoheadrightarrow{n}`,
    String.raw`\verb|a_b|`,
    String.raw`\begin{numcases}{x=}1&x>0\\0&x=0\end{numcases}`
  ])('renders supported TeX synchronously: %s', (expression) => {
    const renderer = createMathRenderer()
    const { node, error } = renderer.render(expression, true)
    expect(error).toBeNull()
    expect(renderer.errors).toEqual([])
    const output = JSON.stringify(node)
    expect(output).toContain('"tagName":"svg"')
    expect(output).toContain('"tagName":"mjx-assistive-mml"')
    expect(output).toContain('"tagName":"math"')
    expect(output).not.toMatch(/"(?:src|href|xlink:href)":/)
    if (expression.startsWith(String.raw`\ce`)) expect(output).toContain('"data-c":"E429"')
  })

  it('retains macros within a document and isolates interleaved documents and diagnostics', () => {
    const first = createMathRenderer()
    expect(first.render(String.raw`\newcommand{\localmacro}{x}`).error).toBeNull()
    const second = createMathRenderer()
    expect(second.render(String.raw`\localmacro`).error?.message).toContain('Undefined control sequence')
    expect(first.render(String.raw`\localmacro`).error).toBeNull()
    expect(second.render(String.raw`\newcommand{\localmacro}{y}\localmacro`).error).toBeNull()
    expect(first.errors).toEqual([])
    expect(second.errors).toHaveLength(1)
    expect(createMathRenderer().render(String.raw`\localmacro`).error).not.toBeNull()
  })

  it('reports each parse, compile or typeset failure once and continues rendering', () => {
    const renderer = createMathRenderer()
    for (const expression of [String.raw`\unknownFormula`, String.raw`\frac{1}{`]) {
      const result = renderer.render(expression)
      expect(result.error?.expression).toBe(expression)
      expect(result.error?.message).not.toBe('[object Object]')
      expect(result.node.children).toEqual([{ type: 'text', value: expression }])
    }
    const compile = vi.spyOn(TeX.prototype, 'compile').mockImplementationOnce(() => { throw new Error('compile failed') })
    try {
      expect(renderer.render('x').error?.message).toBe('compile failed')
    } finally { compile.mockRestore() }
    const typeset = vi.spyOn(SVG.prototype, 'typeset').mockImplementationOnce(() => { throw new Error('typeset failed') })
    try {
      expect(renderer.render('x').error?.message).toBe('typeset failed')
    } finally { typeset.mockRestore() }
    expect(renderer.errors).toHaveLength(4)
    expect(renderer.render('x^2').error).toBeNull()
    expect(renderer.errors).toHaveLength(4)
  })
})
