import { describe, expect, it } from 'vitest'
import type { IndexIssue } from '../../src/shared/contracts.js'
import {
  intentInvalidatesPaper,
  intentLabel,
  shouldResolveDraft,
  type WorkspaceIntent
} from '../../src/renderer/src/workspace-transitions.js'

const issue: IndexIssue = {
  id: 'issue-one',
  rootId: 'root-one',
  rootLabel: 'Methods',
  path: '/research/methods/broken.json',
  relativePath: 'broken.json',
  message: 'Unreadable artifact',
  updatedAt: '2026-08-20T00:00:00.000Z'
}

describe('workspace transition draft policy', () => {
  const invalidatingIntents: WorkspaceIntent[] = [
    { kind: 'select-paper', paperId: 'paper-b' },
    { kind: 'select-issue', issue },
    { kind: 'change-scope', scope: { kind: 'all' } },
    { kind: 'open-radar' },
    { kind: 'change-radar-scope', scope: { kind: 'root', rootId: 'root-two' } },
    { kind: 'remove-root', rootId: 'root-one' },
    { kind: 'reload-paper' }
  ]

  it.each(invalidatingIntents)('resolves the active dirty draft before $kind', (intent) => {
    expect(shouldResolveDraft({ paperId: 'paper-a', dirty: true }, 'paper-a', intent)).toBe(true)
  })

  it('does not interrupt a no-op paper selection or unrelated/clean draft', () => {
    expect(
      shouldResolveDraft(
        { paperId: 'paper-a', dirty: true },
        'paper-a',
        { kind: 'select-paper', paperId: 'paper-a' }
      )
    ).toBe(false)
    expect(
      shouldResolveDraft(
        { paperId: 'paper-b', dirty: true },
        'paper-a',
        { kind: 'open-radar' }
      )
    ).toBe(false)
    expect(
      shouldResolveDraft(
        { paperId: 'paper-a', dirty: false },
        'paper-a',
        { kind: 'quit', requestId: 'quit-one' }
      )
    ).toBe(false)
  })

  it('lets close and quit use the automatic journal flush path', () => {
    expect(
      shouldResolveDraft(
        { paperId: 'paper-a', dirty: true },
        'paper-a',
        { kind: 'close-window', requestId: 'close-one' }
      )
    ).toBe(false)
    expect(
      shouldResolveDraft(
        { paperId: 'paper-a', dirty: true },
        'paper-a',
        { kind: 'quit', requestId: 'quit-one' }
      )
    ).toBe(false)
  })

  it('classifies and labels transition destinations without executing them', () => {
    expect(intentInvalidatesPaper({ kind: 'select-paper', paperId: 'paper-a' }, 'paper-a')).toBe(false)
    expect(
      intentLabel(
        { kind: 'remove-root', rootId: 'root-one' },
        { rootLabel: () => 'Methods' }
      )
    ).toBe('removing Methods')
    expect(intentLabel({ kind: 'select-issue', issue })).toBe(
      'the indexing issue in broken.json'
    )
  })
})
