import { describe, expect, it } from 'vitest'
import { parseMarkdownTable } from '../../src/shared/markdown-table.js'

describe('parseMarkdownTable', () => {
  it('parses GFM rows, alignment, and missing cells', () => {
    expect(
      parseMarkdownTable(`
| Class | Name | Change (%) |
|---:|:---|:---:|
| 1 | Nearly closed | 1.13 |
| 2 | Limited open |
`)
    ).toEqual({
      headers: ['Class', 'Name', 'Change (%)'],
      alignments: ['right', 'left', 'center'],
      rows: [
        ['1', 'Nearly closed', '1.13'],
        ['2', 'Limited open', '']
      ]
    })
  })

  it('keeps escaped pipes inside a cell', () => {
    expect(
      parseMarkdownTable(`
Label | Meaning
--- | ---
A \\| B | combined
`)?.rows
    ).toEqual([['A | B', 'combined']])
  })

  it('preserves scientific backslashes that do not escape a pipe or backslash', () => {
    expect(
      parseMarkdownTable(String.raw`
Symbol | Meaning
--- | ---
\alpha | coefficient
`)?.rows
    ).toEqual([[String.raw`\alpha`, 'coefficient']])
  })

  it('does not mistake prose or a malformed delimiter for a table', () => {
    expect(parseMarkdownTable('A sentence | with punctuation')).toBeNull()
    expect(parseMarkdownTable('A | B\n-- | ---')).toBeNull()
    expect(parseMarkdownTable('A | B\n--- | --- | ---')).toBeNull()
  })
})
