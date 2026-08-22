import { describe, expect, it } from 'vitest'
import {
  hasUnsavedNoteDraft,
  shouldConfirmDiscardNoteDraft
} from '../../src/renderer/src/note-selection.js'

describe('hasUnsavedNoteDraft', () => {
  it('detects a draft owned by the current paper before any library navigation', () => {
    expect(hasUnsavedNoteDraft('paper-a', 'paper-a')).toBe(true)
    expect(hasUnsavedNoteDraft('paper-a', 'paper-b')).toBe(false)
    expect(hasUnsavedNoteDraft(null, 'paper-a')).toBe(false)
  })
})

describe('shouldConfirmDiscardNoteDraft', () => {
  it('guards a cross-paper selection when the current paper has an unsaved draft', () => {
    expect(shouldConfirmDiscardNoteDraft('paper-a', 'paper-b', 'paper-a')).toBe(true)
  })

  it.each([
    ['paper-a', 'paper-a', 'paper-a'],
    ['paper-a', 'paper-b', null],
    ['paper-a', 'paper-b', 'paper-c'],
    [null, 'paper-b', 'paper-a']
  ])('does not guard an unrelated selection state', (current, next, dirty) => {
    expect(shouldConfirmDiscardNoteDraft(current, next, dirty)).toBe(false)
  })
})
