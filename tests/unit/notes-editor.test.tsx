import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DraftTransitionDialog,
  MyNotesContent
} from '../../src/renderer/src/App.js'

const noOp = (): void => undefined

function openingTag(markup: string, id: string): string {
  return markup.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`))?.[0] ?? ''
}

function renderNotes(initialNoteMode?: 'write' | 'preview'): string {
  return renderToStaticMarkup(
    <MyNotesContent
      hasUnsavedChanges
      initialNoteMode={initialNoteMode}
      noteDraft="A **draft** with $x^2$."
      onClose={noOp}
      onNoteChange={noOp}
      onSave={noOp}
      onTagChange={noOp}
      saveBusy={false}
      saveDisabled={false}
      tagDraft="methods"
      tagError={null}
    />
  )
}

describe('MyNotesContent', () => {
  it('keeps the editor mounted but defers preview rendering in Write mode', () => {
    const markup = renderNotes()

    expect(markup).toContain('id="paper-private-note"')
    expect(markup).toContain('aria-labelledby="paper-private-note-label"')
    const previewPanel = openingTag(markup, 'paper-note-preview-panel')
    expect(previewPanel).toContain('role="tabpanel"')
    expect(previewPanel).toContain('tabindex="-1"')
    expect(previewPanel).toContain('hidden=""')
    expect(markup).not.toContain('<strong>draft</strong>')
  })

  it('renders the current draft in a keyboard-focusable Preview panel', () => {
    const markup = renderNotes('preview')

    const writePanel = openingTag(markup, 'paper-note-write-panel')
    const previewPanel = openingTag(markup, 'paper-note-preview-panel')
    expect(writePanel).toContain('role="tabpanel"')
    expect(writePanel).toContain('hidden=""')
    expect(previewPanel).toContain('role="tabpanel"')
    expect(previewPanel).toContain('tabindex="0"')
    expect(previewPanel).not.toContain('hidden=""')
    expect(markup).toContain('<strong>draft</strong>')
    expect(markup).toContain('<math')
  })

  it('announces a recovered durable draft and its local persistence state', () => {
    const markup = renderToStaticMarkup(
      <MyNotesContent
        draftPersistenceStatus="saved"
        draftRecoveredAt="2026-08-20T00:00:00.000Z"
        hasUnsavedChanges
        noteDraft="Recovered text"
        onClose={noOp}
        onNoteChange={noOp}
        onSave={noOp}
        onTagChange={noOp}
        saveBusy={false}
        saveDisabled={false}
        tagDraft="raw, tags"
        tagError={null}
      />
    )

    expect(markup).toContain('role="status"')
    expect(markup).toContain('Recovered unsaved draft')
    expect(markup).toContain('Draft saved locally · choose Save notes to commit')
  })
})

describe('DraftTransitionDialog', () => {
  it('offers save, discard, and cancel while defaulting focus to keep editing', () => {
    const markup = renderToStaticMarkup(
      <DraftTransitionDialog
        busyAction={null}
        currentPaperTitle="Current paper"
        destination="opening Next paper"
        error={null}
        onCancel={noOp}
        onDiscard={noOp}
        onSave={noOp}
        saveDisabled={false}
      />
    )

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('Save changes before continuing?')
    expect(markup).toContain('recoverable on this device')
    expect(markup).toContain('Current paper')
    expect(markup).toContain('Next paper')
    expect(markup).toContain('autofocus=""')
    expect(markup).toContain('Keep editing')
    expect(markup).toContain('Discard and continue')
    expect(markup).toContain('Save and continue')
  })

  it('offers retry, discard-and-close, and cancel after close-time draft persistence fails', () => {
    const markup = renderToStaticMarkup(
      <DraftTransitionDialog
        busyAction={null}
        currentPaperTitle="Current paper"
        destination="quitting PaperRelay"
        error="The local database is busy."
        lifecycleRecovery
        onCancel={noOp}
        onDiscard={noOp}
        onSave={noOp}
        saveDisabled={false}
      />
    )

    expect(markup).toContain('Draft could not be saved locally')
    expect(markup).toContain('The local database is busy.')
    expect(markup).toContain('Retry and continue')
    expect(markup).toContain('Discard draft and continue')
    expect(markup).toContain('Keep editing')
  })
})
