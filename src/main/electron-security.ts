import type { Session } from 'electron'

type PermissionPolicySession = Pick<
  Session,
  'setPermissionCheckHandler' | 'setPermissionRequestHandler'
>

export function developmentRendererUrl(
  isPackaged: boolean,
  configuredUrl: string | undefined
): string | null {
  if (isPackaged) return null
  const url = configuredUrl?.trim()
  return url || null
}

export function denyRendererPermissions(target: PermissionPolicySession): void {
  target.setPermissionCheckHandler(() => false)
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
}
