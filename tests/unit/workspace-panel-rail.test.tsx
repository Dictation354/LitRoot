import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { READER_NOTES_PANEL_ID } from '../../src/renderer/src/ReaderWorkspaceLayout.js'
import {
  WORKSPACE_LIBRARY_PANEL_ID,
  WORKSPACE_NAVIGATION_PANEL_ID,
  WORKSPACE_TERMINAL_PANEL_ID,
  WorkspacePanelRail
} from '../../src/renderer/src/WorkspacePanelRail.js'

const noOp = (): void => undefined

describe('WorkspacePanelRail', () => {
  it('keeps restore controls available while navigation and papers are hidden', () => {
    const markup = renderToStaticMarkup(
      <WorkspacePanelRail
        libraryOpen={false}
        navigationOpen={false}
        notesAvailable={false}
        notesOpen={false}
        onToggleLibrary={noOp}
        onToggleNavigation={noOp}
        onToggleNotes={noOp}
      />
    )

    expect(markup).toContain('aria-label="Workspace panels"')
    expect(markup).toContain(`aria-controls="${WORKSPACE_NAVIGATION_PANEL_ID}"`)
    expect(markup).toContain(`aria-controls="${WORKSPACE_LIBRARY_PANEL_ID}"`)
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(2)
    expect(markup).toContain('aria-label="Show navigation panel"')
    expect(markup).toContain('aria-label="Show papers panel"')
    expect(markup).toContain('aria-label="notes panel unavailable"')
    expect(markup).not.toContain(`aria-controls="${READER_NOTES_PANEL_ID}"`)
    expect(markup).not.toContain(WORKSPACE_TERMINAL_PANEL_ID)
  })

  it('exposes live notes and optional terminal panels as disclosures', () => {
    const markup = renderToStaticMarkup(
      <WorkspacePanelRail
        libraryOpen
        navigationOpen
        notesAvailable
        notesOpen
        onToggleLibrary={noOp}
        onToggleNavigation={noOp}
        onToggleNotes={noOp}
        onToggleTerminal={noOp}
        terminalOpen={false}
        terminalRunning
      />
    )

    expect(markup).toContain(`aria-controls="${READER_NOTES_PANEL_ID}"`)
    expect(markup).toContain('aria-label="Hide notes panel"')
    expect(markup).toContain(`aria-controls="${WORKSPACE_TERMINAL_PANEL_ID}"`)
    expect(markup).toContain('aria-label="Show agent terminal panel, Codex running"')
    expect(markup).toContain('workspace-panel-status-dot')
  })
})
