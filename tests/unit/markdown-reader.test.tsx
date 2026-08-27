import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownReader } from '../../src/renderer/src/MarkdownReader.js'

describe('safe Markdown reader', () => {
  it('removes active HTML and dangerous links and does not request remote images', () => {
    const html = renderToStaticMarkup(
      <MarkdownReader
        projectId="project_aaaaaaaaaaaaaaaaaaaaaaaa"
        paperId="paper_bbbbbbbbbbbbbbbbbbbbbbbb"
        markdown={'<script>alert(1)</script>\n<a href="javascript:alert(2)" onclick="steal()">bad</a>\n![remote](https://evil.test/tracker.png)\n<picture><source srcset="https://evil.test/source.png"><img src="https://evil.test/fallback.png"></picture>'}
      />
    )
    expect(html).not.toMatch(/<script|onclick|javascript:/i)
    expect(html).not.toContain('https://evil.test/tracker.png')
    expect(html).not.toContain('https://evil.test/source.png')
    expect(html).not.toContain('<source')
    expect(html).toContain('远程或不安全图片已阻止')
  })

  it('renders GFM tables, fenced code and KaTeX output', () => {
    const html = renderToStaticMarkup(
      <MarkdownReader
        projectId="project_aaaaaaaaaaaaaaaaaaaaaaaa"
        paperId="paper_bbbbbbbbbbbbbbbbbbbbbbbb"
        markdown={'| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst safe = true\n```\n\n$E = mc^2$'}
      />
    )
    expect(html).toContain('<table>')
    expect(html).toContain('language-ts')
    expect(html).toContain('class="katex"')
  })
})
