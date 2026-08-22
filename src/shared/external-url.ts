const MAX_EXTERNAL_URL_CHARACTERS = 2_048
const CONTROL_OR_WHITESPACE = /[\u0000-\u0020\u007f]/u

/** Return a normalized public web URL, or null for an unsafe/unsupported target. */
export function safeExternalHttpUrl(value: string | null | undefined): string | null {
  if (
    !value ||
    value.length > MAX_EXTERNAL_URL_CHARACTERS ||
    CONTROL_OR_WHITESPACE.test(value)
  ) {
    return null
  }

  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}
