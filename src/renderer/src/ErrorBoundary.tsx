import { Component, type ErrorInfo, type ReactNode } from 'react'

type ErrorFallback = (error: Error, reset: () => void) => ReactNode

interface ErrorBoundaryProps {
  children: ReactNode
  fallback: ReactNode | ErrorFallback
  onError?: (error: Error, info: ErrorInfo) => void
}

interface ErrorBoundaryState {
  error: Error | null
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: normalizeError(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (this.props.onError) {
      this.props.onError(error, info)
      return
    }
    console.error('Renderer component failed.', error, info.componentStack)
  }

  private readonly reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return typeof this.props.fallback === 'function'
      ? this.props.fallback(error, this.reset)
      : this.props.fallback
  }
}

interface BoundaryChildrenProps {
  children: ReactNode
}

export function ApplicationErrorBoundary({ children }: BoundaryChildrenProps) {
  return (
    <ErrorBoundary fallback={(error, reset) => (
      <main className="render-error application-render-error" role="alert">
        <span className="eyebrow">RENDER ERROR</span>
        <h1>界面渲染失败</h1>
        <p>项目文件没有被修改。可以先重试渲染；如果问题仍在，请重新载入应用。</p>
        <details><summary>错误详情</summary><code>{error.message}</code></details>
        <div className="button-row">
          <button type="button" onClick={reset}>重试渲染</button>
          <button type="button" className="primary-button" onClick={() => window.location.reload()}>重新载入</button>
        </div>
      </main>
    )}>
      {children}
    </ErrorBoundary>
  )
}

export function ReaderErrorBoundary({ children }: BoundaryChildrenProps) {
  return (
    <ErrorBoundary fallback={(error, reset) => (
      <div className="render-error reader-render-error" role="alert">
        <span className="eyebrow">READER ERROR</span>
        <h2>正文渲染失败</h2>
        <p>文献列表、元数据和笔记仍可使用。切换文献会自动恢复正文区域。</p>
        <details><summary>错误详情</summary><code>{error.message}</code></details>
        <button type="button" onClick={reset}>重试正文渲染</button>
      </div>
    )}>
      {children}
    </ErrorBoundary>
  )
}
