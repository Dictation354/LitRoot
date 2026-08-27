import { describe, expect, it } from 'vitest'
import { parseBatchInput } from '../../src/shared/batch-input.js'

describe('batch input', () => {
  it('preserves order and duplicate entries while normalizing whitespace', () => {
    expect(parseBatchInput(' first  title \n\n10.1/test\n first  title ').inputs).toEqual([
      'first title', '10.1/test', 'first title'
    ])
  })

  it('enforces the 50 item contract', () => {
    expect(() => parseBatchInput(Array.from({ length: 51 }, (_, index) => `paper ${index}`).join('\n'))).toThrow('50')
  })
})
