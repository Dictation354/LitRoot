import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NotePreview } from '../../src/renderer/src/NotePreview'

function render(markdown: string): string {
  return renderToStaticMarkup(<NotePreview markdown={markdown} />)
}

describe('NotePreview', () => {
  it('renders Markdown, safe HTML, TeX, tables, code, and web links', () => {
    const markup = render(String.raw`# Main finding

This is **important**, uses <mark>safe HTML</mark>, H<sub>2</sub>O, and $x^2 + y^2$.

> A useful quotation.

| Method | Score |
| --- | ---: |
| SBAS | 0.93 |

$$
\Delta z = v t
$$

[Open the source](https://example.com/paper "Source")

${'```text'}
$not_math$ <script>alert(1)</script>
${'```'}`)

    expect(markup).toContain('<h3>Main finding</h3>')
    expect(markup).toContain('<strong>important</strong>')
    expect(markup).toContain('<mark>safe HTML</mark>')
    expect(markup).toContain('<sub>2</sub>')
    expect(markup.match(/<math(?:\s|>)/g)).toHaveLength(2)
    expect(markup).toContain('<table>')
    expect(markup).toContain('scope="col"')
    expect(markup).toContain('href="https://example.com/paper"')
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener noreferrer"')
    expect(markup).toContain('$not_math$ &lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('strips active HTML, resource loads, raw MathML, and unsafe attributes', () => {
    const markup = render(String.raw`<script>alert(1)</script>
<style>body { display: none }</style>
<img src="https://tracker.test/pixel" onerror="alert(1)">
<svg onload="alert(1)"><a href="javascript:alert(1)">svg link</a></svg>
<math><mi href="data:text/html,bad">raw math</mi></math>
<iframe srcdoc="<script>alert(1)</script>"></iframe>
<form><input formaction="https://tracker.test"></form>
<p id="paper-reader-panel" class="reader-shell" style="color:red" onclick="alert(1)">Kept text</p>

$x$

<a href="javascript:alert(1)" target="_self">Unsafe HTML link</a>
[Unsafe Markdown link](data:text/html,bad)
[Relative link](/private/file)`)

    expect(markup).not.toMatch(/<(?:script|style|img|svg|iframe|form|input)(?:\s|>)/u)
    expect(markup).not.toMatch(/(?:onerror|onload|onclick|srcdoc|formaction)/u)
    expect(markup).not.toContain('style="color:red"')
    expect(markup).not.toContain('class="reader-shell"')
    expect(markup).not.toContain('id="paper-reader-panel"')
    expect(markup).not.toContain('tracker.test')
    expect(markup).not.toContain('javascript:')
    expect(markup).not.toContain('data:text')
    expect(markup).not.toContain('href="/private/file"')
    expect(markup).toContain('Kept text')
    expect(markup).toContain('Unsafe HTML link')
    expect(markup.match(/<math(?:\s|>)/g)).toHaveLength(1)
    expect(markup).not.toContain('raw math')
  })

  it('renders safe raw-HTML links with the same protected external-link behavior', () => {
    const markup = render(
      '<a href="https://example.com/paper?q=one&amp;part=two" title="Publisher copy" target="_self" onclick="alert(1)">Publisher copy</a>'
    )

    expect(markup).toContain('href="https://example.com/paper?q=one&amp;part=two"')
    expect(markup).toContain('title="Publisher copy"')
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('rel="noopener noreferrer"')
    expect(markup).toContain('referrerPolicy="no-referrer"')
    expect(markup).not.toContain('target="_self"')
    expect(markup).not.toContain('onclick')
  })

  it('renders a note at the exact 20,000-character editor limit', () => {
    const note = 'a'.repeat(20_000)
    const markup = render(note)

    expect(markup).toContain(`<p>${note}</p>`)
    expect(markup).not.toContain('Preview unavailable')
  })

  it('keeps entity-encoded hostile links inert and strips encoded resource loads', () => {
    const markup = render(String.raw`<a href="java&#x73;cript&#58;alert(1)">Entity link</a>
<a href="javascript%3Aalert(1)">Percent link</a>
<picture><source srcset="https&#58;//tracker.test/source"><img src="https&#58;//tracker.test/pixel"></picture>
<object data="data&#58;text/html,bad">Object fallback</object>
<video poster="https&#58;//tracker.test/poster"><source src="https&#58;//tracker.test/video"></video>`)

    expect(markup).toContain('Entity link')
    expect(markup).toContain('Percent link')
    expect(markup).not.toMatch(/<(?:picture|source|img|object|video)(?:\s|>)/u)
    expect(markup).not.toContain('href=')
    expect(markup).not.toContain('tracker.test')
    expect(markup).not.toContain('javascript')
    expect(markup).not.toContain('data:text')
  })

  it('keeps trust-dependent TeX commands inert and code literal', () => {
    const markup = render(String.raw`Unsafe formula: $\href{https://evil.test}{click}$

Inline code: ${'`$x$ <b>literal</b>`'}

${'```html'}
<a href="https://example.com">not a live link</a>
$$x$$
${'```'}`)

    expect(markup).not.toContain('href="https://evil.test')
    expect(markup).toContain('\\href{https://evil.test}{click}')
    expect(markup).toContain('$x$ &lt;b&gt;literal&lt;/b&gt;')
    expect(markup).toContain('&lt;a href=&quot;https://example.com&quot;&gt;not a live link&lt;/a&gt;')
    expect(markup.match(/<math(?:\s|>)/g) ?? []).toHaveLength(0)
  })

  it('does not let raw HTML or fenced code impersonate trusted math', () => {
    const markup = render(String.raw`<code class="math-inline">x^2</code>

<code class="math-display">\href{https://evil.test}{click}</code>

${'```math'}
y^2
${'```'}`)

    expect(markup).not.toContain('<math')
    expect(markup).not.toContain('href="https://evil.test')
    expect(markup).toContain('<code>x^2</code>')
    expect(markup).toContain('\\href{https://evil.test}{click}')
    expect(markup).toContain('y^2')
  })

  it('caps the number of rendered formulas per note', () => {
    const markup = render(Array.from({ length: 205 }, (_, index) => `$x_${index}$`).join(' '))

    expect(markup.match(/<math(?:\s|>)/g)).toHaveLength(200)
    expect(markup).toContain('$x_204$')
  })

  it('does not confuse ordinary currency prose with math', () => {
    const markup = render('The project cost $41 million in 2020 and $0.7 billion later.')
    expect(markup).not.toContain('<math')
    expect(markup).toContain('$41 million')
  })

  it('renders an empty state without a live or interactive surface', () => {
    const markup = render('  \n')
    expect(markup).toContain('Nothing to preview yet.')
    expect(markup).not.toContain('aria-live')
  })
})
