import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  AgentTerminalExit,
  PaperRelayBridge,
  RootSummary
} from '../../src/shared/contracts.js'
import {
  AgentTerminalPanel,
  AgentTerminalSetup,
  chooseTerminalRootId,
  terminalAccessLabel,
  terminalExitMessage
} from '../../src/renderer/src/AgentTerminalPanel.js'

const noOp = (): void => undefined

const terminalBridge: PaperRelayBridge['agentTerminal'] = {
  start: async () => null,
  write: async () => undefined,
  resize: async () => undefined,
  stop: async () => undefined,
  onOutput: () => noOp,
  onExit: () => noOp
}

const roots: RootSummary[] = [
  {
    id: 'root-a',
    path: '/research/a',
    label: 'Project A',
    status: 'ready',
    error: null,
    paperCount: 3,
    issueCount: 0,
    lastScannedAt: null,
    createdAt: '2026-08-20T00:00:00.000Z'
  },
  {
    id: 'root-b',
    path: '/research/b',
    label: 'Project B',
    status: 'unavailable',
    error: null,
    paperCount: 1,
    issueCount: 0,
    lastScannedAt: null,
    createdAt: '2026-08-20T00:00:00.000Z'
  }
]

describe('AgentTerminalSetup', () => {
  it('defaults to an explicit read-only launch and lists registered roots', () => {
    const markup = renderToStaticMarkup(
      <AgentTerminalSetup
        access="read-only"
        error={null}
        onAccessChange={noOp}
        onRootChange={noOp}
        onStart={noOp}
        roots={roots}
        selectedRootId="root-a"
        starting={false}
      />
    )

    expect(markup).toContain('Nothing starts until you select Start Codex')
    expect(markup).toContain('<option value="root-a" selected="">Project A</option>')
    expect(markup).toContain('Project B — unavailable')
    expect(markup).toMatch(/<input[^>]*checked=""[^>]*value="read-only"/)
    expect(markup).toContain('Start Codex</button>')
    expect(markup).not.toContain('explicit confirmation before launching')
  })

  it('warns before the authoritative workspace-write confirmation', () => {
    const markup = renderToStaticMarkup(
      <AgentTerminalSetup
        access="workspace-write"
        error={null}
        onAccessChange={noOp}
        onRootChange={noOp}
        onStart={noOp}
        roots={roots}
        selectedRootId="root-a"
        starting={false}
      />
    )

    expect(markup).toMatch(/<input[^>]*checked=""[^>]*value="workspace-write"/)
    expect(markup).toContain('confirms folder write access first')
    expect(markup).toContain('Review any later Codex approval prompts separately')
    expect(markup).toContain('Review &amp; start Codex')
  })

  it('does not offer a start action without a registered root', () => {
    const markup = renderToStaticMarkup(
      <AgentTerminalSetup
        access="read-only"
        error={null}
        onAccessChange={noOp}
        onRootChange={noOp}
        onStart={noOp}
        roots={[]}
        selectedRootId=""
        starting={false}
      />
    )

    expect(markup).toContain('No registered folders')
    expect(markup).toContain('Connect a research folder to start Codex')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*type="submit"/)
  })
})

describe('AgentTerminalPanel', () => {
  it('renders safely during SSR without initializing the browser terminal', () => {
    const markup = renderToStaticMarkup(
      <AgentTerminalPanel
        bridge={terminalBridge}
        onHide={noOp}
        onRunningChange={noOp}
        roots={roots}
        suggestedRootId="root-b"
        visible
      />
    )

    expect(markup).toContain('id="workspace-terminal-panel"')
    expect(markup).toContain('<h2 id="agent-terminal-heading">Codex Console</h2>')
    expect(markup).toContain('Not started')
    expect(markup).toContain('<option value="root-b" selected="">Project B — unavailable</option>')
    expect(markup).not.toContain('xterm-surface')
  })
})

describe('terminal presentation helpers', () => {
  it('keeps a valid selection, then prefers the suggested root', () => {
    expect(chooseTerminalRootId(roots, 'root-a', 'root-b')).toBe('root-a')
    expect(chooseTerminalRootId(roots, 'missing', 'root-b')).toBe('root-b')
    expect(chooseTerminalRootId(roots, 'missing', null)).toBe('root-a')
    expect(chooseTerminalRootId([], 'missing', null)).toBe('')
  })

  it('uses concise access and exit labels', () => {
    expect(terminalAccessLabel('read-only')).toBe('Read-only')
    expect(terminalAccessLabel('workspace-write')).toBe('Workspace write')

    const exit = (patch: Partial<AgentTerminalExit>): AgentTerminalExit => ({
      sessionId: 'session-1',
      exitCode: null,
      signal: null,
      reason: 'exited',
      ...patch
    })
    expect(terminalExitMessage(exit({ exitCode: 0 }))).toBe('Session finished')
    expect(terminalExitMessage(exit({ exitCode: 9 }))).toBe('Session exited with code 9')
    expect(terminalExitMessage(exit({ reason: 'stopped' }))).toBe('Session stopped')
    expect(terminalExitMessage(exit({ reason: 'error' }))).toBe(
      'Session ended with an error'
    )
  })
})
