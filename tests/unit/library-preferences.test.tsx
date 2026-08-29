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

  it('persists column visibility, order, width and sorting', () => {
    const storage = new MemoryStorage()
    const defaults = defaultLibraryPreferences()
    const columns = reorderLibraryColumns(defaults.columns, 'journal', 'title').map((column) => (
      column.key === 'authors' ? { ...column, visible: false, width: 312 } : column
    ))
    const preferences = {
      ...defaults,
      columns,
      sortBy: 'year' as const,
      sortDirection: 'desc' as const
    }

    saveLibraryPreferences(storage, preferences)
    expect(loadLibraryPreferences(storage)).toEqual(preferences)
    expect(storage.getItem(LIBRARY_PREFERENCES_KEY)).toContain('"width":312')
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
