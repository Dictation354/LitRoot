import { describe, expect, it } from 'vitest'
import {
  EMPTY_RESOURCE_ERRORS,
  withResourceError
} from '../../src/renderer/src/resource-errors.js'

describe('resource-scoped errors', () => {
  it('clears only the resource that succeeded', () => {
    const failed = withResourceError(
      withResourceError(EMPTY_RESOURCE_ERRORS, 'summary', 'Summary unavailable'),
      'detail',
      'Paper unavailable'
    )
    const summaryRecovered = withResourceError(failed, 'summary', null)

    expect(summaryRecovered).toEqual({
      summary: null,
      list: null,
      'load-more': null,
      detail: 'Paper unavailable'
    })
  })

  it('does not allocate a new state object for an unchanged message', () => {
    const failed = withResourceError(EMPTY_RESOURCE_ERRORS, 'list', 'Search unavailable')
    expect(withResourceError(failed, 'list', 'Search unavailable')).toBe(failed)
  })
})
