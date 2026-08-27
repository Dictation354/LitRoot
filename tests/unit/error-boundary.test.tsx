import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../../src/renderer/src/ErrorBoundary.js'

describe('renderer error boundary', () => {
  it('replaces a failed subtree with its fallback and reports the error', () => {
    const error = new Error('reader exploded')
    const onError = vi.fn()
    const boundary = new ErrorBoundary({
      children: <p>reader content</p>,
      fallback: (caught) => <div role="alert">正文渲染失败：{caught.message}</div>,
      onError
    })

    expect(renderToStaticMarkup(boundary.render())).toContain('reader content')
    boundary.state = ErrorBoundary.getDerivedStateFromError(error)
    expect(renderToStaticMarkup(boundary.render())).toContain('正文渲染失败：reader exploded')

    boundary.componentDidCatch(error, { componentStack: '\n    at BrokenReader' })
    expect(onError).toHaveBeenCalledWith(error, { componentStack: '\n    at BrokenReader' })
  })
})
