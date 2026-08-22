import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DetailWorkspaceLayout } from '../../src/renderer/src/DetailWorkspaceLayout.js'

describe('DetailWorkspaceLayout', () => {
  it('places the terminal after the article-and-notes workspace', () => {
    const markup = renderToStaticMarkup(
      <DetailWorkspaceLayout
        primary={<div>Article and notes</div>}
        terminal={<section>Codex Console</section>}
        terminalOpen
      />
    )

    expect(markup).toContain('has-terminal-panel')
    expect(markup).not.toContain('hidden=""')
    expect(markup.indexOf('Article and notes')).toBeLessThan(markup.indexOf('Codex Console'))
  })

  it('keeps the terminal mounted but hidden so a live session survives toggling', () => {
    const markup = renderToStaticMarkup(
      <DetailWorkspaceLayout
        primary={<div>Article and notes</div>}
        terminal={<section>Live terminal state</section>}
        terminalOpen={false}
      />
    )

    expect(markup).not.toContain('has-terminal-panel')
    expect(markup).toContain('hidden=""')
    expect(markup).toContain('Live terminal state')
  })
})
