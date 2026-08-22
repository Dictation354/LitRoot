import { describe, expect, it } from 'vitest'
import { readerAssets } from '../../src/shared/reader-assets.js'
import type { PaperAsset } from '../../src/shared/contracts.js'

function asset(overrides: Partial<PaperAsset> = {}): PaperAsset {
  return {
    kind: 'figure',
    heading: 'Figure 1',
    caption: null,
    path: null,
    url: null,
    section: 'Results',
    available: false,
    previewUrl: null,
    ...overrides
  }
}

describe('readerAssets', () => {
  it('deduplicates kind and heading while preferring an available local asset', () => {
    const pathless = asset({ caption: 'Metadata-only figure' })
    const local = asset({
      heading: '  figure   1 ',
      caption: 'Downloaded figure',
      path: '/research/assets/figure-1.png',
      available: true,
      previewUrl: 'paperrelay-asset://preview/figure-1'
    })

    expect(readerAssets([pathless, local])).toEqual([local])
  })

  it('omits pathless tables but retains a table with a local artifact', () => {
    const pathlessTable = asset({ kind: 'table', heading: 'Table 1' })
    const localTable = asset({
      kind: 'Table',
      heading: 'Table 2',
      path: '/research/assets/table-2.png',
      available: true,
      previewUrl: 'paperrelay-asset://preview/table-2'
    })

    expect(readerAssets([pathlessTable, localTable])).toEqual([localTable])
  })

  it('does not collapse unnamed assets that lack a reliable identity', () => {
    const first = asset({ heading: '', path: '/research/assets/a.png' })
    const second = asset({ heading: '  ', path: '/research/assets/b.png' })

    expect(readerAssets([first, second])).toEqual([first, second])
  })
})
