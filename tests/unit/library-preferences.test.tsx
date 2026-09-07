import { describe, expect, it } from 'vitest'
import {
  defaultLibraryPreferences,
  LIBRARY_PREFERENCES_KEY,
  loadLibraryPreferences,
  normalizeLibraryPreferences,
  reorderLibraryColumns,
  saveLibraryPreferences
} from '../../src/renderer/src/library-preferences.js'
import { paperSearchRequestSchema } from '../../src/shared/contracts.js'
import { libraryAuthorLine } from '../../src/renderer/src/LibraryTable.js'

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('library preferences', () => {
  it('shortens author lists starting with the third author', () => {
    expect(libraryAuthorLine([])).toBe('—')
    expect(libraryAuthorLine(['Ada'])).toBe('Ada')
    expect(libraryAuthorLine(['Ada', 'Grace'])).toBe('Ada; Grace')
    expect(libraryAuthorLine(['Ada', 'Grace', 'Linus'])).toBe('Ada et al.')
    expect(libraryAuthorLine(['Ada', 'Grace', 'Linus', 'Barbara'])).toBe('Ada et al.')
  })

  it('persists column visibility, order, width, sorting and page size', () => {
    const storage = new MemoryStorage()
    const defaults = defaultLibraryPreferences()
    const columns = reorderLibraryColumns(defaults.columns, 'journal', 'title').map((column) => (
      column.key === 'authors' ? { ...column, visible: false, width: 312 } : column
    ))
    const preferences = {
      ...defaults,
      columns,
      sortBy: 'year' as const,
      sortDirection: 'desc' as const,
      pageSize: 200
    }

    saveLibraryPreferences(storage, preferences)
    expect(loadLibraryPreferences(storage)).toEqual(preferences)
    expect(storage.getItem(LIBRARY_PREFERENCES_KEY)).toContain('"width":312')
  })

  it.each([20, 50, 100, 200])('restores the supported page size %i', (pageSize) => {
    const storage = new MemoryStorage()
    saveLibraryPreferences(storage, { ...defaultLibraryPreferences(), pageSize })
    expect(loadLibraryPreferences(storage).pageSize).toBe(pageSize)
  })

  it.each([undefined, null, '100', 0, 21, 201, 50.5])('defaults old or invalid page sizes (%s) to 50', (pageSize) => {
    const storage = new MemoryStorage()
    storage.setItem(LIBRARY_PREFERENCES_KEY, JSON.stringify({
      ...defaultLibraryPreferences(), sortBy: 'year', sortDirection: 'desc', pageSize
    }))
    expect(loadLibraryPreferences(storage)).toMatchObject({ pageSize: 50, sortBy: 'year', sortDirection: 'desc' })
  })

  it('uses defaults for missing, malformed or unreadable storage and tolerates failed writes', () => {
    const storage = new MemoryStorage()
    expect(loadLibraryPreferences(storage).pageSize).toBe(50)
    storage.setItem(LIBRARY_PREFERENCES_KEY, '{')
    expect(loadLibraryPreferences(storage).pageSize).toBe(50)
    const unavailable = {
      getItem: () => { throw new Error('unavailable') },
      setItem: () => { throw new Error('unavailable') }
    }
    expect(loadLibraryPreferences(unavailable).pageSize).toBe(50)
    expect(() => saveLibraryPreferences(unavailable, defaultLibraryPreferences())).not.toThrow()
  })

  it('repairs corrupt or incomplete values and always keeps a visible column', () => {
    const repaired = normalizeLibraryPreferences({
      version: 1,
      columns: defaultLibraryPreferences().columns.map((column) => ({
        ...column,
        visible: false,
        ...(column.key === 'title' ? { width: 9 } : {})
      })),
      sortBy: 'injected SQL',
      sortDirection: 'sideways'
    })

    expect(repaired.columns).toHaveLength(10)
    expect(repaired.columns.find((column) => column.key === 'title')).toMatchObject({
      visible: true,
      width: 64
    })
    expect(repaired).toMatchObject({ sortBy: 'title', sortDirection: 'asc' })
  })

  it('rejects non-whitelisted server sort fields', () => {
    expect(() => paperSearchRequestSchema.parse({
      projectId: 'project_test',
      sortBy: 'title; DROP TABLE papers',
      sortDirection: 'asc'
    })).toThrow()
  })
})
