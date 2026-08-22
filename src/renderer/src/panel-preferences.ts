export const WORKSPACE_PANEL_PREFERENCES_STORAGE_KEY = 'paperrelay.workspace.panels'

export type WorkspacePanelId = 'navigation' | 'library' | 'notes' | 'terminal'

export interface WorkspacePanelPreferences {
  version: 1
  navigation: boolean
  library: boolean
  notes: boolean
  terminal: boolean
}

interface PreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const DEFAULT_WORKSPACE_PANEL_PREFERENCES: WorkspacePanelPreferences = {
  version: 1,
  navigation: true,
  library: true,
  notes: false,
  terminal: false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseWorkspacePanelPreferences(
  serialized: string | null
): WorkspacePanelPreferences {
  if (!serialized) return { ...DEFAULT_WORKSPACE_PANEL_PREFERENCES }

  try {
    const value: unknown = JSON.parse(serialized)
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      typeof value.navigation !== 'boolean' ||
      typeof value.library !== 'boolean' ||
      typeof value.notes !== 'boolean' ||
      typeof value.terminal !== 'boolean'
    ) {
      return { ...DEFAULT_WORKSPACE_PANEL_PREFERENCES }
    }

    return {
      version: 1,
      navigation: value.navigation,
      library: value.library,
      notes: value.notes,
      terminal: value.terminal
    }
  } catch {
    return { ...DEFAULT_WORKSPACE_PANEL_PREFERENCES }
  }
}

export function readWorkspacePanelPreferences(
  storage: PreferenceStorage
): WorkspacePanelPreferences {
  try {
    return parseWorkspacePanelPreferences(
      storage.getItem(WORKSPACE_PANEL_PREFERENCES_STORAGE_KEY)
    )
  } catch {
    return { ...DEFAULT_WORKSPACE_PANEL_PREFERENCES }
  }
}

export function writeWorkspacePanelPreferences(
  storage: PreferenceStorage,
  preferences: WorkspacePanelPreferences
): boolean {
  try {
    storage.setItem(
      WORKSPACE_PANEL_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences)
    )
    return true
  } catch {
    return false
  }
}

export function withWorkspacePanelVisibility(
  preferences: WorkspacePanelPreferences,
  panel: WorkspacePanelId,
  open: boolean
): WorkspacePanelPreferences {
  if (preferences[panel] === open) return preferences
  return { ...preferences, [panel]: open }
}
