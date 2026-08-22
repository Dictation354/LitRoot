import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MathText } from '../../src/renderer/src/MathText.js'
import { TextBlocks } from '../../src/renderer/src/App.js'
import { extractAuthorYearAliases } from '../../src/shared/citation-crossrefs.js'

describe('citation rendering', () => {
  it('renders an exact author-year citation as an internal reference link', () => {
    const aliases = extractAuthorYearAliases([
      { number: 4, text: 'Efficient phase estimation [Ansari et al., 2018]' }
    ])
    const markup = renderToStaticMarkup(
      <MathText
        referenceAliases={aliases}
        referenceNumbers={[4]}
        text="Prior work (Ansari et al., 2018) established the method."
      />
    )

    expect(markup).toContain('href="#paper-reference-4"')
    expect(markup).toContain('data-reference-numbers="4"')
    expect(markup).toContain('Ansari et al., 2018</a>')
  })

  it('links prose citations but not citation-like TeX content', () => {
    const markup = renderToStaticMarkup(
      <MathText referenceNumbers={[1, 2]} text={'$A=[1,2]$ cites [2].'} />
    )

    expect(markup.match(/href="#paper-reference-/g)).toHaveLength(1)
    expect(markup).toContain('href="#paper-reference-2"')
  })

  it('links verified author-year citations in scientific table cells', () => {
    const aliases = extractAuthorYearAliases([
      { number: 57, text: 'Open-source processing [Sandwell et al., 2011]' }
    ])
    const markup = renderToStaticMarkup(
      <TextBlocks
        referenceAliases={aliases}
        referenceNumbers={[57]}
        text={'| Method | Source |\n| --- | --- |\n| GMTSAR | Sandwell et al. (2011); data [57] |'}
      />
    )

    expect(markup).toContain('<table')
    expect(markup).toContain('href="#paper-reference-57"')
    expect(markup).toContain('Sandwell et al. (2011)</a>')
    expect(markup).not.toContain('>[57]</a>')
  })
})
