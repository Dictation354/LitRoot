import { describe, expect, it } from 'vitest'
import { isSafeLocalImageSource, safeMarkdownLink } from '../../src/shared/markdown-security.js'

describe('Markdown URL safety', () => {
  it.each(['javascript:alert(1)', 'data:text/html,boom', 'file:///etc/passwd', '//evil.test/x'])('blocks link %s', (value) => {
    expect(safeMarkdownLink(value)).toBeNull()
  })

  it('allows plain HTTP(S) links without embedded credentials', () => {
    expect(safeMarkdownLink('https://example.test/paper')).toBe('https://example.test/paper')
    expect(safeMarkdownLink('https://user:secret@example.test')).toBeNull()
  })

  it.each(['../secret.png', '%2e%2e/secret.png', '/etc/passwd', 'https://evil.test/a.png', 'data:image/png,x'])('blocks unsafe image source %s', (value) => {
    expect(isSafeLocalImageSource(value)).toBe(false)
  })

  it('allows a relative project asset', () => {
    expect(isSafeLocalImageSource('assets/figure-1.png')).toBe(true)
  })
})
