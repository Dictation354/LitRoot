import type { ReactNode } from 'react'

export function DetailWorkspaceLayout({
  primary,
  terminal,
  terminalOpen
}: {
  primary: ReactNode
  terminal: ReactNode
  terminalOpen: boolean
}): React.JSX.Element {
  return (
    <div
      className={`detail-workspace-layout ${terminalOpen ? 'has-terminal-panel' : ''}`}
    >
      <div className="detail-primary-panel">{primary}</div>
      <div className="agent-terminal-slot" hidden={!terminalOpen}>
        {terminal}
      </div>
    </div>
  )
}
