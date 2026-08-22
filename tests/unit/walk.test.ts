import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPathInsideRoot } from '../../src/main/ingest/walk.js'

describe('path containment', () => {
  it('rejects Windows paths on a different drive', () => {
    expect(isPathInsideRoot('C:\\research', 'D:\\private\\figure.png', win32)).toBe(false)
  })

  it('keeps Windows containment case-insensitive without accepting siblings', () => {
    expect(isPathInsideRoot('C:\\Research', 'c:\\research\\paper\\figure.png', win32)).toBe(true)
    expect(isPathInsideRoot('C:\\Research', 'C:\\Research-archive\\figure.png', win32)).toBe(false)
  })
})
