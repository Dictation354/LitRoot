import type { PaperSection } from './contracts.js'

function comparableText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

export function visibleReaderSections(
  sections: PaperSection[],
  abstract: string | null
): Array<{ section: PaperSection; index: number }> {
  const comparableAbstract = abstract ? comparableText(abstract) : null

  return sections
    .map((section, index) => ({ section, index }))
    .filter(({ section }) => {
      if (!comparableAbstract || section.kind.toLocaleLowerCase() !== 'abstract') return true
      return comparableText(section.text) !== comparableAbstract
    })
}
