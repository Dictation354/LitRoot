import { describe, expect, it, vi } from 'vitest'
import {
  denyRendererPermissions,
  developmentRendererUrl
} from '../../src/main/electron-security.js'

describe('Electron security policy', () => {
  it('uses a configured renderer URL only for an unpackaged development app', () => {
    expect(developmentRendererUrl(false, ' http://127.0.0.1:5173 ')).toBe(
      'http://127.0.0.1:5173'
    )
    expect(developmentRendererUrl(true, 'http://attacker.test')).toBeNull()
    expect(developmentRendererUrl(false, '   ')).toBeNull()
    expect(developmentRendererUrl(false, undefined)).toBeNull()
  })

  it('denies permission checks and requests through the default session', () => {
    const setPermissionCheckHandler = vi.fn()
    const setPermissionRequestHandler = vi.fn()
    denyRendererPermissions({
      setPermissionCheckHandler,
      setPermissionRequestHandler
    } as never)

    const check = setPermissionCheckHandler.mock.calls[0]?.[0] as () => boolean
    const request = setPermissionRequestHandler.mock.calls[0]?.[0] as (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void
    ) => void
    const callback = vi.fn()

    expect(check()).toBe(false)
    request({}, 'geolocation', callback)
    expect(callback).toHaveBeenCalledWith(false)
  })
})
