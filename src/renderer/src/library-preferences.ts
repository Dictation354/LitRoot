import type { PaperSortField, SortDirection } from '../../shared/contracts'

export const LIBRARY_PREFERENCES_KEY = 'litroot.library-preferences.v1'

export const LIBRARY_COLUMN_KEYS = [
  'title',
  'authors',
  'year',
  'journal',
  'contentKind',
  'doi',
  'source',
  'addedAt',
  'lastOpenedAt',
  'modifiedAt'
] as const

export type LibraryColumnKey = typeof LIBRARY_COLUMN_KEYS[number]

export interface LibraryColumnPreference {
  key: LibraryColumnKey
  visible: boolean
  width: number
}

export interface LibraryPreferences {
  version: 1
  columns: LibraryColumnPreference[]
  sortBy: PaperSortField
  sortDirection: SortDirection
}

interface PreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const COLUMN_DEFAULTS: Record<LibraryColumnKey, { visible: boolean; width: number }> = {
  title: { visible: true, width: 380 },
  authors: { visible: true, width: 220 },
  year: { visible: true, width: 84 },
  journal: { visible: true, width: 220 },
  contentKind: { visible: false, width: 108 },
  doi: { visible: false, width: 190 },
  source: { visible: false, width: 140 },
  addedAt: { visible: true, width: 150 },
  lastOpenedAt: { visible: true, width: 150 },
  modifiedAt: { visible: false, width: 150 }
}

const SORT_FIELDS = new Set<PaperSortField>([
  'title',
  'authors',
  'year',
  'journal',
  'contentKind',
  'source',
  'addedAt',
  'lastOpenedAt',
  'modifiedAt'
])

export function defaultLibraryPreferences(): LibraryPreferences {
  return {
    version: 1,
    columns: LIBRARY_COLUMN_KEYS.map((key) => ({ key, ...COLUMN_DEFAULTS[key] })),
    sortBy: 'title',
    sortDirection: 'asc'
  }
}

function isColumnKey(value: unknown): value is LibraryColumnKey {
  return typeof value === 'string' && (LIBRARY_COLUMN_KEYS as readonly string[]).includes(value)
}

function normalizeColumn(value: unknown): LibraryColumnPreference | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (!isColumnKey(candidate.key)) return null
  const fallback = COLUMN_DEFAULTS[candidate.key]
  const width = typeof candidate.width === 'number' && Number.isFinite(candidate.width)
    ? Math.min(640, Math.max(64, Math.round(candidate.width)))
    : fallback.width
  return {
    key: candidate.key,
    visible: typeof candidate.visible === 'boolean' ? candidate.visible : fallback.visible,
    width
  }
}

export function normalizeLibraryPreferences(value: unknown): LibraryPreferences {
  const defaults = defaultLibraryPreferences()
  if (!value || typeof value !== 'object') return defaults
  const candidate = value as Record<string, unknown>
  if (candidate.version !== 1 || !Array.isArray(candidate.columns)) return defaults

  const seen = new Set<LibraryColumnKey>()
  const columns = candidate.columns.flatMap((value) => {
    const column = normalizeColumn(value)
    if (!column || seen.has(column.key)) return []
    seen.add(column.key)
    return [column]
  })
  for (const column of defaults.columns) {
    if (!seen.has(column.key)) columns.push(column)
  }
  if (!columns.some((column) => column.visible)) {
    const title = columns.find((column) => column.key === 'title')
    if (title) title.visible = true
  }

  return {
    version: 1,
    columns,
    sortBy: SORT_FIELDS.has(candidate.sortBy as PaperSortField)
      ? candidate.sortBy as PaperSortField
      : defaults.sortBy,
    sortDirection: candidate.sortDirection === 'desc' ? 'desc' : 'asc'
  }
}

export function loadLibraryPreferences(storage: PreferenceStorage): LibraryPreferences {
  try {
    const raw = storage.getItem(LIBRARY_PREFERENCES_KEY)
    return raw ? normalizeLibraryPreferences(JSON.parse(raw)) : defaultLibraryPreferences()
  } catch {
    return defaultLibraryPreferences()
  }
}

export function saveLibraryPreferences(
  storage: PreferenceStorage,
  preferences: LibraryPreferences
): void {
  try {
    storage.setItem(LIBRARY_PREFERENCES_KEY, JSON.stringify(preferences))
  } catch {
    // The library remains usable when browser preferences are unavailable.
  }
}

export function reorderLibraryColumns(
  columns: LibraryColumnPreference[],
  source: LibraryColumnKey,
  target: LibraryColumnKey
): LibraryColumnPreference[] {
  const sourceIndex = columns.findIndex((column) => column.key === source)
  const targetIndex = columns.findIndex((column) => column.key === target)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return columns
  const next = [...columns]
  const [moved] = next.splice(sourceIndex, 1)
  if (!moved) return columns
  next.splice(targetIndex, 0, moved)
  return next
}
