import type { IndexIssue } from '../../shared/contracts.js'

export type WorkspaceScopeIntent =
  | { kind: 'all' }
  | { kind: 'attention' }
  | { kind: 'user'; userView: 'favorites' | 'reading_list' | 'reviewed' }
  | { kind: 'root'; rootId: string }

export type WorkspaceIntent =
  | { kind: 'select-paper'; paperId: string }
  | { kind: 'select-issue'; issue: IndexIssue }
  | { kind: 'change-scope'; scope: WorkspaceScopeIntent }
  | { kind: 'open-radar' }
  | { kind: 'change-radar-scope'; scope: WorkspaceScopeIntent }
  | { kind: 'remove-root'; rootId: string }
  | { kind: 'reload-paper' }
  | { kind: 'close-window'; requestId: string }
  | { kind: 'quit'; requestId: string }

export interface ActiveDraftState {
  paperId: string
  dirty: boolean
}

export function intentInvalidatesPaper(
  intent: WorkspaceIntent,
  currentPaperId: string | null
): boolean {
  if (intent.kind === 'select-paper') return intent.paperId !== currentPaperId
  return true
}

export function shouldResolveDraft(
  draft: ActiveDraftState | null,
  currentPaperId: string | null,
  intent: WorkspaceIntent
): boolean {
  if (intent.kind === 'close-window' || intent.kind === 'quit') return false
  return Boolean(
    draft?.dirty &&
      currentPaperId &&
      draft.paperId === currentPaperId &&
      intentInvalidatesPaper(intent, currentPaperId)
  )
}

export function intentLabel(
  intent: WorkspaceIntent,
  options: {
    paperTitle?(paperId: string): string | null
    rootLabel?(rootId: string): string | null
  } = {}
): string {
  switch (intent.kind) {
    case 'select-paper':
      return options.paperTitle?.(intent.paperId) ?? 'another paper'
    case 'select-issue':
      return `the indexing issue in ${intent.issue.relativePath}`
    case 'change-scope':
      return 'another library view'
    case 'open-radar':
      return 'Research Radar'
    case 'change-radar-scope':
      return 'another Research Radar scope'
    case 'remove-root':
      return `removing ${options.rootLabel?.(intent.rootId) ?? 'this research folder'}`
    case 'reload-paper':
      return 'the refreshed paper'
    case 'close-window':
      return 'closing PaperRelay'
    case 'quit':
      return 'quitting PaperRelay'
  }
}
