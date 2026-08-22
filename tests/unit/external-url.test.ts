import { describe, expect, it } from 'vitest'
import { safeExternalHttpUrl } from '../../src/shared/external-url.js'

describe('safeExternalHttpUrl', () => {
  it.each([
    ['https://example.com/paper?q=1', 'https://example.com/paper?q=1'],
    ['HTTP://EXAMPLE.COM/path', 'http://example.com/path']
  ])('allows and normalizes public HTTP links', (input, expected) => {
    expect(safeExternalHttpUrl(input)).toBe(expected)
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///tmp/private.txt',
    'paperrelay-asset://preview/paper/1',
    '//example.com/path',
    '/relative/path',
    'mailto:person@example.com',
    'https://user:secret@example.com/',
    'https://example.com/white space',
    `https://example.com/${'a'.repeat(2_100)}`
  ])('rejects unsupported or ambiguous link %s', (input) => {
    expect(safeExternalHttpUrl(input)).toBeNull()
  })
})
