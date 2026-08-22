import { useEffect, useRef } from 'react'
import type { AgentRelaySetup } from '../../shared/contracts'
import { Icon } from './icons'

export type AgentRelayAction = 'config' | 'prompt' | null

interface AgentRelaySheetProps {
  setup: AgentRelaySetup | null
  loading: boolean
  activeAction: AgentRelayAction
  onClose(): void
  onCopyConfig(): void
  onCopyPrompt(): void
  onRefresh(): void
}

const relayTools = [
  {
    icon: 'map-pin' as const,
    title: 'Project context',
    description: 'Scope searches to a connected research folder using its stable root ID.'
  },
  {
    icon: 'search' as const,
    title: 'Library search',
    description: 'Search scholarly metadata and full text across every indexed project.'
  },
  {
    icon: 'book-open' as const,
    title: 'Targeted reading',
    description: 'Retrieve only the abstract or sections needed for the current task.'
  },
  {
    icon: 'file' as const,
    title: 'Figures & provenance',
    description: 'Inspect figure captions, source locations, and extraction health.'
  }
]

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    (element) => element.getAttribute('aria-hidden') !== 'true' && element.tabIndex >= 0
  )
}

export function AgentRelaySheet({
  setup,
  loading,
  activeAction,
  onClose,
  onCopyConfig,
  onCopyPrompt,
  onRefresh
}: AgentRelaySheetProps): React.JSX.Element {
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const configCopyButtonRef = useRef<HTMLButtonElement>(null)
  const promptCopyButtonRef = useRef<HTMLButtonElement>(null)
  const localCopyLockRef = useRef<AgentRelayAction>(null)
  const previousActionRef = useRef<AgentRelayAction>(activeAction)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const focusInside = (): void => {
      const target = closeButtonRef.current ?? focusableElements(dialog)[0] ?? dialog
      target.focus()
    }
    const initialFocusFrame = window.requestAnimationFrame(focusInside)

    const containKeyboardFocus = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = focusableElements(dialog)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement
      if (!dialog.contains(active)) {
        event.preventDefault()
        const target = event.shiftKey ? last : first
        target.focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    const containProgrammaticFocus = (event: FocusEvent): void => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusInside()
    }

    document.addEventListener('keydown', containKeyboardFocus, true)
    document.addEventListener('focusin', containProgrammaticFocus)
    return () => {
      window.cancelAnimationFrame(initialFocusFrame)
      document.removeEventListener('keydown', containKeyboardFocus, true)
      document.removeEventListener('focusin', containProgrammaticFocus)
    }
  }, [onClose])

  const available = Boolean(setup?.available)

  useEffect(() => {
    const previousAction = previousActionRef.current
    previousActionRef.current = activeAction

    if (activeAction !== null) {
      localCopyLockRef.current = activeAction
    } else {
      localCopyLockRef.current = null
    }

    const actionToFocus = activeAction ?? previousAction
    const dialog = dialogRef.current
    if (!actionToFocus || !dialog || dialog.contains(document.activeElement)) return

    const actionButton =
      actionToFocus === 'config' ? configCopyButtonRef.current : promptCopyButtonRef.current
    const target = actionButton && !actionButton.disabled ? actionButton : closeButtonRef.current
    const focusFrame = window.requestAnimationFrame(() => target?.focus())
    return () => window.cancelAnimationFrame(focusFrame)
  }, [activeAction])

  const requestCopy = (action: Exclude<AgentRelayAction, null>): void => {
    if (!available || activeAction !== null || localCopyLockRef.current !== null) return
    localCopyLockRef.current = action
    if (action === 'config') onCopyConfig()
    else onCopyPrompt()
  }

  const statusLabel = loading
    ? 'Checking local relay'
    : available
      ? 'Ready for Codex'
      : 'Setup unavailable'

  return (
    <div className="relay-sheet-backdrop" onMouseDown={onClose} role="presentation">
      <section
        aria-describedby="agent-relay-description"
        aria-labelledby="agent-relay-title"
        aria-modal="true"
        className="relay-sheet"
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="relay-sheet-header">
          <div className="relay-heading-mark" aria-hidden="true">
            <Icon name="bot" size={22} />
            <span>✦</span>
          </div>
          <div className="relay-heading-copy">
            <div className="relay-eyebrow">Local agent bridge</div>
            <h2 id="agent-relay-title">Agent Relay</h2>
            <p id="agent-relay-description">
              Let Codex search and read your PaperRelay library without changing source files.
            </p>
          </div>
          <button
            aria-label="Close Agent Relay setup"
            autoFocus
            className="relay-close-button"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            <Icon name="x" size={17} />
          </button>
        </header>

        <div className="relay-sheet-scroll">
          <div
            aria-live="polite"
            className={`relay-status-card ${available ? 'is-ready' : setup && !loading ? 'has-error' : ''}`}
          >
            <span className="relay-status-icon">
              <Icon
                className={loading ? 'spin' : ''}
                name={loading ? 'refresh' : available ? 'shield' : 'triangle-alert'}
                size={18}
              />
            </span>
            <span className="relay-status-copy">
              <strong>{statusLabel}</strong>
              <span>
                {loading
                  ? 'Locating the bundled relay and local catalog…'
                  : available
                    ? 'The relay is installed locally and exposes read-only research tools.'
                    : setup?.error ?? 'PaperRelay could not locate the local relay executable.'}
              </span>
            </span>
            {!loading && !available && (
              <button className="secondary-button compact-button" onClick={onRefresh} type="button">
                <Icon name="refresh" size={14} />
                Check again
              </button>
            )}
          </div>

          <section className="relay-section">
            <div className="relay-section-heading">
              <span>What agents can do</span>
              <span className="relay-readonly-pill">
                <Icon name="shield" size={12} />
                Read-only
              </span>
            </div>
            <div className="relay-tools-grid">
              {relayTools.map((tool) => (
                <article className="relay-tool-card" key={tool.title}>
                  <span>
                    <Icon name={tool.icon} size={17} />
                  </span>
                  <div>
                    <strong>{tool.title}</strong>
                    <p>{tool.description}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="relay-section">
            <div className="relay-section-heading">
              <span>Local catalog</span>
            </div>
            <div className="relay-path-list">
              <div className="relay-path-row">
                <span className="relay-path-icon">
                  <Icon name="database" size={16} />
                </span>
                <div>
                  <span>Catalog path</span>
                  <code>{setup?.databasePath || 'Checking…'}</code>
                </div>
              </div>
              <div className="relay-path-row">
                <span className="relay-path-icon">
                  <Icon name="terminal" size={16} />
                </span>
                <div>
                  <span>Relay server</span>
                  <code>{setup?.serverPath || 'Checking…'}</code>
                </div>
              </div>
            </div>
          </section>

          <section className="relay-section relay-setup-section">
            <div className="relay-section-heading">
              <span>Connect Codex</span>
              <span>One-time setup</span>
            </div>
            <p className="relay-section-intro">
              Add this configuration in Codex Settings → MCP servers, or paste it into config.toml.
              Save it, restart Codex, then start a new task. The relay connection uses local stdio;
              it opens no network port and requires no separate relay account.
            </p>
            <div className="relay-code-block">
              <div className="relay-code-topline">
                <span>Codex configuration</span>
                <button
                  aria-disabled={activeAction !== null ? true : undefined}
                  disabled={!available}
                  onClick={() => requestCopy('config')}
                  ref={configCopyButtonRef}
                  type="button"
                >
                  <Icon
                    className={activeAction === 'config' ? 'spin' : ''}
                    name={activeAction === 'config' ? 'refresh' : 'copy'}
                    size={13}
                  />
                  {activeAction === 'config' ? 'Copying…' : 'Copy setup'}
                </button>
              </div>
              <pre>{setup?.codexConfig || '# Relay configuration will appear here'}</pre>
            </div>
            {setup?.cliCommand && (
              <div className="relay-command-row">
                <span>Server command</span>
                <code>{setup.cliCommand}</code>
              </div>
            )}
          </section>

          <section className="relay-section relay-test-section">
            <div className="relay-test-copy">
              <span className="relay-test-icon">
                <Icon name="sparkles" size={18} />
              </span>
              <div>
                <strong>Try the connection</strong>
                <p>{setup?.testPrompt || 'Ask Codex to summarize your PaperRelay library.'}</p>
              </div>
            </div>
            <button
              aria-disabled={activeAction !== null ? true : undefined}
              className="secondary-button"
              disabled={!available}
              onClick={() => requestCopy('prompt')}
              ref={promptCopyButtonRef}
              type="button"
            >
              <Icon
                className={activeAction === 'prompt' ? 'spin' : ''}
                name={activeAction === 'prompt' ? 'refresh' : 'copy'}
                size={15}
              />
              {activeAction === 'prompt' ? 'Copying…' : 'Copy test prompt'}
            </button>
          </section>

          <div className="relay-safety-note">
            <Icon name="shield" size={15} />
            <div className="relay-safety-copy">
              <p>
                <strong>Read-only source access.</strong> Agent Relay can inspect PaperRelay’s
                normalized index, but cannot add folders, edit papers, or write into your research
                projects.
              </p>
              <p>
                <strong>Codex conversation.</strong> This setup auto-approves these read-only tools,
                so Codex may call them without a prompt for each call. Retrieved research may be
                included in your Codex conversation under its data controls.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
