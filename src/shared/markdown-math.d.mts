import type { Element } from 'hast'
import type { Plugin } from 'unified'
import type { Root } from 'hast'

export interface MathDiagnostic {
  expression: string
  displayMode: boolean
  message: string
}

export const mathjaxVersion: string
export const mathjaxExtensions: readonly string[]
export function createMathRenderer(): {
  errors: MathDiagnostic[]
  render(expression: string, displayMode?: boolean): { node: Element; error: MathDiagnostic | null }
  stylesheet(): Element
}
export const rehypeMathjax: Plugin<[], Root>
