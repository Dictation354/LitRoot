import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentTerminalAccess,
  AgentTerminalExit,
  AgentTerminalOutput,
  AgentTerminalSession,
  PaperRelayBridge,
  RootSummary
} from '../../shared/contracts'
import { Icon } from './icons'
import { WORKSPACE_TERMINAL_PANEL_ID } from './WorkspacePanelRail'
import {
  XtermSurface,
  type TerminalDimensions,
  type XtermSurfaceHandle
} from './XtermSurface'

const DEFAULT_TERMINAL_DIMENSIONS: TerminalDimensions = { cols: 100, rows: 24 }
const MAX_PENDING_OUTPUT_CHARACTERS = 1_000_000

export function terminalAccessLabel(access: AgentTerminalAccess): string {
  return access === 'read-only' ? 'Read-only' : 'Workspace write'
}

export function terminalExitMessage(exit: AgentTerminalExit): string {
  if (exit.reason === 'stopped') return 'Session stopped'
  if (exit.reason === 'error') return 'Session ended with an error'
  if (exit.exitCode === 0) return 'Session finished'
  if (exit.exitCode !== null) return `Session exited with code ${exit.exitCode}`
  return 'Session exited'
}

export function chooseTerminalRootId(
  roots: RootSummary[],
  currentRootId: string,
  suggestedRootId: string | null
): string {
  if (roots.some((root) => root.id === currentRootId)) return currentRootId
  if (suggestedRootId && roots.some((root) => root.id === suggestedRootId)) {
    return suggestedRootId
  }
  return roots[0]?.id ?? ''
}

interface AgentTerminalSetupProps {
  access: AgentTerminalAccess
  error: string | null
  onAccessChange(access: AgentTerminalAccess): void
  onRootChange(rootId: string): void
  onStart(): void
  roots: RootSummary[]
  selectedRootId: string
  starting: boolean
}

export function AgentTerminalSetup({
  access,
  error,
  onAccessChange,
  onRootChange,
  onStart,
  roots,
  selectedRootId,
  starting
}: AgentTerminalSetupProps): React.JSX.Element {
  const canStart = Boolean(selectedRootId) && !starting

  return (
    <div className="agent-terminal-setup">
      <div className="agent-terminal-setup-copy">
        <span className="agent-terminal-setup-icon" aria-hidden="true">
          <Icon name="terminal" size={22} />
        </span>
        <div>
          <h3>Start a local Codex session</h3>
          <p>
            Choose a registered research folder and access level. Nothing starts until you
            select Start Codex.
          </p>
        </div>
      </div>

      <form
        className="agent-terminal-start-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (canStart) onStart()
        }}
      >
        <label className="agent-terminal-root-field" htmlFor="agent-terminal-root">
          <span>Research folder</span>
          <select
            disabled={roots.length === 0 || starting}
            id="agent-terminal-root"
            onChange={(event) => onRootChange(event.target.value)}
            value={selectedRootId}
          >
            {roots.length === 0 ? (
              <option value="">No registered folders</option>
            ) : (
              roots.map((root) => (
                <option key={root.id} value={root.id}>
                  {root.label}
                  {root.status === 'unavailable' || root.status === 'error'
                    ? ' — unavailable'
                    : ''}
                </option>
              ))
            )}
          </select>
        </label>

        <fieldset className="agent-terminal-access-field" disabled={starting}>
          <legend>Access</legend>
          <label className={access === 'read-only' ? 'is-selected' : ''}>
            <input
              checked={access === 'read-only'}
              name="agent-terminal-access"
              onChange={() => onAccessChange('read-only')}
              type="radio"
              value="read-only"
            />
            <span>
              <strong>Read-only</strong>
              <small>Use Codex's read-only project sandbox.</small>
            </span>
          </label>
          <label className={access === 'workspace-write' ? 'is-selected' : ''}>
            <input
              checked={access === 'workspace-write'}
              name="agent-terminal-access"
              onChange={() => onAccessChange('workspace-write')}
              type="radio"
              value="workspace-write"
            />
            <span>
              <strong>Workspace write</strong>
              <small>Allow edits here; Codex may separately request broader access.</small>
            </span>
          </label>
        </fieldset>

        {access === 'workspace-write' && (
          <div className="agent-terminal-write-warning" role="note">
            <Icon name="triangle-alert" size={15} />
            <span>
              PaperRelay confirms folder write access first. Review any later Codex approval
              prompts separately.
            </span>
          </div>
        )}

        {error && (
          <div className="agent-terminal-error" role="alert">
            <Icon name="triangle-alert" size={15} />
            <span>{error}</span>
          </div>
        )}

        <div className="agent-terminal-start-row">
          {roots.length === 0 && <span>Connect a research folder to start Codex.</span>}
          <button className="primary-button compact-button" disabled={!canStart} type="submit">
            <Icon className={starting ? 'spin' : ''} name={starting ? 'refresh' : 'terminal'} size={15} />
            {starting
              ? 'Starting…'
              : access === 'workspace-write'
                ? 'Review & start Codex'
                : 'Start Codex'}
          </button>
        </div>
      </form>
    </div>
  )
}

interface AgentTerminalPanelProps {
  bridge: PaperRelayBridge['agentTerminal']
  onHide(): void
  onRunningChange(running: boolean): void
  roots: RootSummary[]
  suggestedRootId: string | null
  visible: boolean
}

export function AgentTerminalPanel({
  bridge,
  onHide,
  onRunningChange,
  roots,
  suggestedRootId,
  visible
}: AgentTerminalPanelProps): React.JSX.Element {
  const [selectedRootId, setSelectedRootId] = useState(() =>
    chooseTerminalRootId(roots, '', suggestedRootId)
  )
  const [access, setAccess] = useState<AgentTerminalAccess>('read-only')
  const [session, setSession] = useState<AgentTerminalSession | null>(null)
  const [exit, setExit] = useState<AgentTerminalExit | null>(null)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const surfaceRef = useRef<XtermSurfaceHandle>(null)
  const sessionRef = useRef<AgentTerminalSession | null>(null)
  const sessionLiveRef = useRef(false)
  const dimensionsRef = useRef<TerminalDimensions>(DEFAULT_TERMINAL_DIMENSIONS)
  const pendingOutputRef = useRef<Map<string, string>>(new Map())
  const pendingExitRef = useRef<Map<string, AgentTerminalExit>>(new Map())
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const rootSelectionTouchedRef = useRef(false)

  const running = Boolean(session && !exit)
  const selectedRoot = useMemo(
    () => roots.find((root) => root.id === selectedRootId) ?? null,
    [roots, selectedRootId]
  )

  useEffect(() => {
    if (session) return
    setSelectedRootId((current) =>
      chooseTerminalRootId(
        roots,
        rootSelectionTouchedRef.current || !suggestedRootId ? current : '',
        suggestedRootId
      )
    )
  }, [roots, session, suggestedRootId])

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  useEffect(() => {
    onRunningChange(running)
  }, [onRunningChange, running])

  useEffect(() => {
    const disposeOutput = bridge.onOutput((output: AgentTerminalOutput) => {
      const activeSession = sessionRef.current
      if (
        activeSession?.id === output.sessionId &&
        surfaceRef.current?.write(output.data)
      ) {
        return
      }

      const previous = pendingOutputRef.current.get(output.sessionId) ?? ''
      pendingOutputRef.current.set(
        output.sessionId,
        `${previous}${output.data}`.slice(-MAX_PENDING_OUTPUT_CHARACTERS)
      )
    })
    const disposeExit = bridge.onExit((nextExit: AgentTerminalExit) => {
      if (sessionRef.current?.id === nextExit.sessionId) {
        sessionLiveRef.current = false
        setExit(nextExit)
        setStopping(false)
        const exitLine = `\r\n\x1b[90m[PaperRelay] ${terminalExitMessage(nextExit)}.\x1b[0m\r\n`
        if (!surfaceRef.current?.write(exitLine)) {
          const previous = pendingOutputRef.current.get(nextExit.sessionId) ?? ''
          pendingOutputRef.current.set(nextExit.sessionId, `${previous}${exitLine}`)
        }
        return
      }
      pendingExitRef.current.set(nextExit.sessionId, nextExit)
    })
    return () => {
      disposeOutput()
      disposeExit()
    }
  }, [bridge])

  const flushPendingOutput = useCallback((sessionId: string): void => {
    const pending = pendingOutputRef.current.get(sessionId)
    if (!pending || !surfaceRef.current?.write(pending)) return
    pendingOutputRef.current.delete(sessionId)
  }, [])

  const start = async (): Promise<void> => {
    if (!selectedRootId || starting || running) return
    setStarting(true)
    setError(null)
    setExit(null)
    sessionLiveRef.current = false
    try {
      const nextSession = await bridge.start({
        rootId: selectedRootId,
        access,
        ...dimensionsRef.current
      })
      if (!nextSession) return
      sessionRef.current = nextSession
      sessionLiveRef.current = true
      setSession(nextSession)
      const earlyExit = pendingExitRef.current.get(nextSession.id)
      if (earlyExit) {
        pendingExitRef.current.delete(nextSession.id)
        sessionLiveRef.current = false
        setExit(earlyExit)
        const exitLine = `\r\n\x1b[90m[PaperRelay] ${terminalExitMessage(earlyExit)}.\x1b[0m\r\n`
        const previous = pendingOutputRef.current.get(nextSession.id) ?? ''
        pendingOutputRef.current.set(nextSession.id, `${previous}${exitLine}`)
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not start Codex')
    } finally {
      setStarting(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (!session || exit || stopping) return
    setStopping(true)
    sessionLiveRef.current = false
    setError(null)
    try {
      await bridge.stop(session.id)
    } catch (nextError) {
      sessionLiveRef.current = true
      setStopping(false)
      setError(nextError instanceof Error ? nextError.message : 'Could not stop Codex')
    }
  }

  const write = useCallback(
    (data: string): void => {
      const activeSession = sessionRef.current
      if (!activeSession || !sessionLiveRef.current) return
      writeQueueRef.current = writeQueueRef.current
        .then(() => bridge.write(activeSession.id, data))
        .catch((nextError: unknown) => {
          setError(nextError instanceof Error ? nextError.message : 'Could not send terminal input')
        })
    },
    [bridge]
  )

  const resize = useCallback(
    ({ cols, rows }: TerminalDimensions): void => {
      dimensionsRef.current = { cols, rows }
      const activeSession = sessionRef.current
      if (!activeSession || !sessionLiveRef.current || cols < 1 || rows < 1) return
      void bridge.resize(activeSession.id, cols, rows).catch((nextError: unknown) => {
        setError(nextError instanceof Error ? nextError.message : 'Could not resize the terminal')
      })
    },
    [bridge]
  )

  const resetSession = (): void => {
    if (running) return
    if (session) {
      pendingOutputRef.current.delete(session.id)
      pendingExitRef.current.delete(session.id)
    }
    sessionRef.current = null
    sessionLiveRef.current = false
    setSession(null)
    setExit(null)
    setError(null)
    setAccess('read-only')
  }

  return (
    <section
      aria-labelledby="agent-terminal-heading"
      className="agent-terminal-panel"
      id={WORKSPACE_TERMINAL_PANEL_ID}
    >
      <header className="agent-terminal-header">
        <div className="agent-terminal-title">
          <span className="agent-terminal-title-icon" aria-hidden="true">
            <Icon name="terminal" size={17} />
          </span>
          <div>
            <h2 id="agent-terminal-heading">Codex Console</h2>
            <p>Local agent session</p>
          </div>
        </div>

        <div className="agent-terminal-session-summary" aria-live="polite">
          {session ? (
            <>
              <span className="agent-terminal-context-chip" title={session.cwd}>
                {session.rootLabel}
              </span>
              <span className={`agent-terminal-access-chip is-${session.access}`}>
                {terminalAccessLabel(session.access)}
              </span>
              <span className={`agent-terminal-status ${running ? 'is-running' : 'is-exited'}`}>
                <span aria-hidden="true" />
                {running ? (stopping ? 'Stopping' : 'Running') : exit ? terminalExitMessage(exit) : 'Exited'}
              </span>
            </>
          ) : (
            <span className="agent-terminal-status is-idle">
              <span aria-hidden="true" />
              Not started
            </span>
          )}
        </div>

        <div className="agent-terminal-actions">
          {running && (
            <button
              className="agent-terminal-stop-button"
              disabled={stopping}
              onClick={() => void stop()}
              type="button"
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          )}
          {session && !running && (
            <button className="agent-terminal-new-button" onClick={resetSession} type="button">
              New session
            </button>
          )}
          <button
            aria-label="Hide Codex Console"
            className="agent-terminal-hide-button"
            onClick={onHide}
            title="Hide console (the session keeps running)"
            type="button"
          >
            <Icon name="x" size={15} />
          </button>
        </div>
      </header>

      <div className="agent-terminal-body">
        {session ? (
          <>
            <XtermSurface
              disabled={!running || stopping}
              key={session.id}
              onData={write}
              onError={setError}
              onReady={() => {
                flushPendingOutput(session.id)
                if (visible) surfaceRef.current?.focus()
              }}
              onResize={resize}
              ref={surfaceRef}
              visible={visible}
            />
            {error && (
              <div className="agent-terminal-overlay-error" role="alert">
                <Icon name="triangle-alert" size={14} />
                <span>{error}</span>
                <button aria-label="Dismiss console error" onClick={() => setError(null)} type="button">
                  <Icon name="x" size={13} />
                </button>
              </div>
            )}
          </>
        ) : (
          <AgentTerminalSetup
            access={access}
            error={error}
            onAccessChange={setAccess}
            onRootChange={(rootId) => {
              rootSelectionTouchedRef.current = true
              setSelectedRootId(rootId)
              setAccess('read-only')
              setError(null)
            }}
            onStart={() => void start()}
            roots={roots}
            selectedRootId={selectedRoot?.id ?? ''}
            starting={starting}
          />
        )}
      </div>
    </section>
  )
}
