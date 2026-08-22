import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef
} from 'react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

export interface TerminalDimensions {
  cols: number
  rows: number
}

export interface XtermSurfaceHandle {
  fit(): void
  focus(): void
  write(data: string): boolean
}

interface XtermSurfaceProps {
  disabled: boolean
  onData(data: string): void
  onError(message: string): void
  onReady(): void
  onResize(dimensions: TerminalDimensions): void
  visible: boolean
}

const FIT_DEBOUNCE_MS = 80

export const XtermSurface = forwardRef<XtermSurfaceHandle, XtermSurfaceProps>(
  function XtermSurface(
    { disabled, onData, onError, onReady, onResize, visible },
    forwardedRef
  ): React.JSX.Element {
    const hostRef = useRef<HTMLDivElement>(null)
    const terminalRef = useRef<Terminal | null>(null)
    const fitAddonRef = useRef<FitAddon | null>(null)
    const fitRef = useRef<() => void>(() => undefined)
    const onDataRef = useRef(onData)
    const disabledRef = useRef(disabled)
    const onErrorRef = useRef(onError)
    const onReadyRef = useRef(onReady)
    const onResizeRef = useRef(onResize)
    const lastDimensionsRef = useRef<TerminalDimensions | null>(null)

    onDataRef.current = onData
    disabledRef.current = disabled
    onErrorRef.current = onError
    onReadyRef.current = onReady
    onResizeRef.current = onResize

    useImperativeHandle(
      forwardedRef,
      () => ({
        fit: () => fitRef.current(),
        focus: () => terminalRef.current?.focus(),
        write: (data) => {
          const terminal = terminalRef.current
          if (!terminal) return false
          terminal.write(data)
          return true
        }
      }),
      []
    )

    useEffect(() => {
      let disposed = false
      let resizeObserver: ResizeObserver | null = null
      let fitTimer: number | null = null
      let inputDisposable: { dispose(): void } | null = null

      const reportDimensions = (terminal: Terminal): void => {
        const dimensions = { cols: terminal.cols, rows: terminal.rows }
        const previous = lastDimensionsRef.current
        if (previous?.cols === dimensions.cols && previous.rows === dimensions.rows) return
        lastDimensionsRef.current = dimensions
        onResizeRef.current(dimensions)
      }

      const fit = (): void => {
        const host = hostRef.current
        const terminal = terminalRef.current
        const fitAddon = fitAddonRef.current
        if (!host || !terminal || !fitAddon || host.clientWidth === 0 || host.clientHeight === 0) {
          return
        }
        try {
          fitAddon.fit()
          reportDimensions(terminal)
        } catch {
          // A transient zero-sized layout can occur while the panel is being hidden.
        }
      }
      fitRef.current = fit

      const scheduleFit = (): void => {
        if (fitTimer !== null) window.clearTimeout(fitTimer)
        fitTimer = window.setTimeout(fit, FIT_DEBOUNCE_MS)
      }

      void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
        .then(([{ Terminal: XtermTerminal }, { FitAddon: XtermFitAddon }]) => {
          const host = hostRef.current
          if (disposed || !host) return

          const terminal = new XtermTerminal({
            allowProposedApi: false,
            cursorBlink: true,
            cursorStyle: 'bar',
            disableStdin: disabledRef.current,
            fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
            fontSize: 12.5,
            letterSpacing: 0,
            lineHeight: 1.22,
            linkHandler: null,
            screenReaderMode: true,
            scrollback: 5_000,
            theme: {
              background: '#101719',
              foreground: '#d8e2df',
              cursor: '#82bbb5',
              cursorAccent: '#101719',
              selectionBackground: '#315d5b',
              black: '#172124',
              red: '#e48782',
              green: '#78b99d',
              yellow: '#d7b16e',
              blue: '#7fa8d8',
              magenta: '#b6a0cf',
              cyan: '#75b9bd',
              white: '#d8e2df',
              brightBlack: '#718083',
              brightRed: '#f09a94',
              brightGreen: '#91ccb1',
              brightYellow: '#e5c482',
              brightBlue: '#98bae3',
              brightMagenta: '#c6b2da',
              brightCyan: '#8acbd0',
              brightWhite: '#f5f8f7'
            }
          })
          const fitAddon = new XtermFitAddon()
          terminal.loadAddon(fitAddon)
          terminal.open(host)
          terminalRef.current = terminal
          fitAddonRef.current = fitAddon
          inputDisposable = terminal.onData((data) => onDataRef.current(data))

          resizeObserver = new ResizeObserver(scheduleFit)
          resizeObserver.observe(host)
          window.addEventListener('resize', scheduleFit)
          window.requestAnimationFrame(() => {
            if (disposed) return
            fit()
            onReadyRef.current()
          })
        })
        .catch((error: unknown) => {
          if (disposed) return
          onErrorRef.current(
            error instanceof Error ? error.message : 'Could not initialize the terminal surface'
          )
        })

      return () => {
        disposed = true
        if (fitTimer !== null) window.clearTimeout(fitTimer)
        window.removeEventListener('resize', scheduleFit)
        resizeObserver?.disconnect()
        inputDisposable?.dispose()
        fitAddonRef.current?.dispose()
        terminalRef.current?.dispose()
        fitAddonRef.current = null
        terminalRef.current = null
        fitRef.current = () => undefined
        lastDimensionsRef.current = null
      }
    }, [])

    useEffect(() => {
      if (terminalRef.current) terminalRef.current.options.disableStdin = disabled
    }, [disabled])

    useEffect(() => {
      if (!visible) return
      const frame = window.requestAnimationFrame(() => {
        fitRef.current()
        terminalRef.current?.focus()
      })
      return () => window.cancelAnimationFrame(frame)
    }, [visible])

    return (
      <div
        aria-label="Interactive Codex terminal"
        className="xterm-surface"
        ref={hostRef}
        role="region"
      />
    )
  }
)
