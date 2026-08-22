import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  READER_NOTES_HEADING_ID,
  READER_NOTES_PANEL_ID,
  ReaderWorkspaceLayout
} from '../../src/renderer/src/ReaderWorkspaceLayout'

describe('ReaderWorkspaceLayout', () => {
  it('keeps the reader and an open notes landmark in the same workspace', () => {
    const markup = renderToStaticMarkup(
      <ReaderWorkspaceLayout
        notes={<h2 id={READER_NOTES_HEADING_ID}>My Notes</h2>}
        notesOpen
        reader={<article>Paper text</article>}
      />
    )

    expect(markup).toContain(`id="${READER_NOTES_PANEL_ID}"`)
    expect(markup).toContain(`aria-labelledby="${READER_NOTES_HEADING_ID}"`)
    expect(markup).not.toContain('hidden=""')
    expect(markup).toContain('<article>Paper text</article>')
    expect(markup.indexOf('My Notes')).toBeLessThan(markup.indexOf('Paper text'))
  })

  it('hides only the notes landmark when the dock is closed', () => {
    const markup = renderToStaticMarkup(
      <ReaderWorkspaceLayout
        notes={<h2 id={READER_NOTES_HEADING_ID}>My Notes</h2>}
        notesOpen={false}
        reader={<article>Paper text</article>}
      />
    )

    expect(markup).toContain('hidden=""')
    expect(markup).toContain('<article>Paper text</article>')
  })
})
