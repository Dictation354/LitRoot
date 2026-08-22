import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKSPACE_PANEL_PREFERENCES,
  WORKSPACE_PANEL_PREFERENCES_STORAGE_KEY,
  parseWorkspacePanelPreferences,
  readWorkspacePanelPreferences,
  withWorkspacePanelVisibility,
  writeWorkspacePanelPreferences
} from '../../src/renderer/src/panel-preferences.js'

class MemoryStorage {
  value: string | null = null

  getItem(key: string): string | null {
    expect(key).toBe(WORKSPACE_PANEL_PREFERENCES_STORAGE_KEY)
    return this.value
  }

  setItem(key: string, value: string): void {
    expect(key).toBe(WORKSPACE_PANEL_PREFERENCES_STORAGE_KEY)
    this.value = value
  }
}

describe('workspace panel preferences', () => {
  it('starts with navigation and papers visible, without auxiliary panels', () => {
    expect(parseWorkspacePanelPreferences(null)).toEqual(
      DEFAULT_WORKSPACE_PANEL_PREFERENCES
    )
  })

  it('restores only a complete, versioned set of boolean preferences', () => {
    expect(
      parseWorkspacePanelPreferences(
        JSON.stringify({
          version: 1,
          navigation: false,
          library: true,
          notes: true,
          terminal: false,
          ignored: '<script>'
        })
      )
    ).toEqual({
      version: 1,
      navigation: false,
      library: true,
      notes: true,
      terminal: false
    })

    expect(
      parseWorkspacePanelPreferences(
        JSON.stringify({ version: 1, navigation: 'no', library: false })
      )
    ).toEqual(DEFAULT_WORKSPACE_PANEL_PREFERENCES)
    expect(parseWorkspacePanelPreferences('{bad json')).toEqual(
      DEFAULT_WORKSPACE_PANEL_PREFERENCES
    )
  })

  it('reads, updates, and writes preferences without mutating the prior value', () => {
    const storage = new MemoryStorage()
    const initial = readWorkspacePanelPreferences(storage)
    const next = withWorkspacePanelVisibility(initial, 'library', false)

    expect(next).not.toBe(initial)
    expect(initial.library).toBe(true)
    expect(next.library).toBe(false)
    expect(writeWorkspacePanelPreferences(storage, next)).toBe(true)
    expect(readWorkspacePanelPreferences(storage)).toEqual(next)
  })

  it('leaves an unchanged preference object stable', () => {
    const preferences = { ...DEFAULT_WORKSPACE_PANEL_PREFERENCES }
    expect(withWorkspacePanelVisibility(preferences, 'notes', false)).toBe(
      preferences
    )
  })

  it('falls back safely when storage access is blocked', () => {
    const blockedStorage = {
      getItem(): string | null {
        throw new Error('blocked')
      },
      setItem(): void {
        throw new Error('blocked')
      }
    }

    expect(readWorkspacePanelPreferences(blockedStorage)).toEqual(
      DEFAULT_WORKSPACE_PANEL_PREFERENCES
    )
    expect(
      writeWorkspacePanelPreferences(
        blockedStorage,
        DEFAULT_WORKSPACE_PANEL_PREFERENCES
      )
    ).toBe(false)
  })
})
