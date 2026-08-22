import type { ReactNode } from 'react'

export const READER_NOTES_PANEL_ID = 'paper-notes-panel'
export const READER_NOTES_HEADING_ID = 'paper-notes-heading'

export function ReaderWorkspaceLayout({
  notesOpen,
  notes,
  reader
}: {
  notesOpen: boolean
  notes: ReactNode
  reader: ReactNode
}): React.JSX.Element {
  return (
    <div className={`reader-workspace-layout ${notesOpen ? 'has-notes' : ''}`}>
      <aside
        aria-labelledby={READER_NOTES_HEADING_ID}
        className="notes-side-panel"
        hidden={!notesOpen}
        id={READER_NOTES_PANEL_ID}
      >
        {notes}
      </aside>
      {reader}
    </div>
  )
}
