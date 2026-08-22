import { READER_NOTES_PANEL_ID } from './ReaderWorkspaceLayout'
import { Icon, type IconName } from './icons'

export const WORKSPACE_NAVIGATION_PANEL_ID = 'workspace-navigation-panel'
export const WORKSPACE_LIBRARY_PANEL_ID = 'workspace-library-panel'
export const WORKSPACE_TERMINAL_PANEL_ID = 'workspace-terminal-panel'
export const WORKSPACE_TERMINAL_TOGGLE_ID = 'workspace-terminal-panel-toggle'

interface PanelToggleProps {
  controls?: string
  disabled?: boolean
  icon: IconName
  id?: string
  label: string
  open: boolean
  onToggle(): void
  status?: string | undefined
}

function PanelToggle({
  controls,
  disabled = false,
  icon,
  id,
  label,
  open,
  onToggle,
  status
}: PanelToggleProps): React.JSX.Element {
  const actionLabel = disabled
    ? `${label} unavailable`
    : `${open ? 'Hide' : 'Show'} ${label}${status ? `, ${status}` : ''}`

  return (
    <button
      aria-controls={disabled ? undefined : controls}
      aria-expanded={disabled ? undefined : open}
      aria-label={actionLabel}
      className="workspace-panel-toggle"
      disabled={disabled}
      id={id}
      onClick={onToggle}
      title={actionLabel}
      type="button"
    >
      <Icon name={icon} size={18} />
      {status && <span aria-hidden="true" className="workspace-panel-status-dot" />}
    </button>
  )
}

export function WorkspacePanelRail({
  libraryOpen,
  navigationOpen,
  notesAvailable,
  notesOpen,
  onToggleLibrary,
  onToggleNavigation,
  onToggleNotes,
  onToggleTerminal,
  terminalOpen = false,
  terminalRunning = false
}: {
  libraryOpen: boolean
  navigationOpen: boolean
  notesAvailable: boolean
  notesOpen: boolean
  terminalOpen?: boolean
  terminalRunning?: boolean
  onToggleLibrary(): void
  onToggleNavigation(): void
  onToggleNotes(): void
  onToggleTerminal?: () => void
}): React.JSX.Element {
  return (
    <aside className="workspace-panel-rail">
      <div aria-hidden="true" className="workspace-panel-rail-drag-region" />
      <nav aria-label="Workspace panels" className="workspace-panel-switches">
        <PanelToggle
          controls={WORKSPACE_NAVIGATION_PANEL_ID}
          icon="layers"
          label="navigation panel"
          onToggle={onToggleNavigation}
          open={navigationOpen}
        />
        <PanelToggle
          controls={WORKSPACE_LIBRARY_PANEL_ID}
          icon="inbox"
          label="papers panel"
          onToggle={onToggleLibrary}
          open={libraryOpen}
        />
        <PanelToggle
          controls={READER_NOTES_PANEL_ID}
          disabled={!notesAvailable}
          icon="note"
          label="notes panel"
          onToggle={onToggleNotes}
          open={notesOpen}
        />
        {onToggleTerminal && (
          <div className="workspace-panel-terminal-toggle">
            <PanelToggle
              controls={WORKSPACE_TERMINAL_PANEL_ID}
              icon="terminal"
              id={WORKSPACE_TERMINAL_TOGGLE_ID}
              label="agent terminal panel"
              onToggle={onToggleTerminal}
              open={terminalOpen}
              status={terminalRunning ? 'Codex running' : undefined}
            />
          </div>
        )}
      </nav>
    </aside>
  )
}
