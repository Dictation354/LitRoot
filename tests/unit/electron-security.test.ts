import { describe, expect, it, vi } from 'vitest'
import { denyRendererPermissions, developmentRendererUrl } from '../../src/main/electron-security.js'

describe('Electron security policy', () => {
  it('only uses the configured development renderer outside packaged builds', () => {
    expect(developmentRendererUrl(true, 'http://localhost:5173')).toBeNull()
    expect(developmentRendererUrl(false, ' http://localhost:5173 ')).toBe('http://localhost:5173')
  })

  it('denies every renderer permission', () => {
    let check!: () => boolean
    let request!: (_contents: unknown, _permission: unknown, callback: (allowed: boolean) => void) => void
    denyRendererPermissions({
      setPermissionCheckHandler: (handler) => { check = handler as () => boolean },
      setPermissionRequestHandler: (handler) => { request = handler as typeof request }
    })
    expect(check()).toBe(false)
    const callback = vi.fn()
    request(null, null, callback)
    expect(callback).toHaveBeenCalledWith(false)
  })
})
