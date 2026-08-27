export function safeMarkdownLink(value: string): string | null {
  if (value.startsWith('#') && !value.startsWith('#blocked')) return value
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

export function isSafeLocalImageSource(value: string): boolean {
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|\/|\\)/i.test(value)) return false
  let decoded: string
  try {
    decoded = decodeURIComponent(value.split(/[?#]/, 1)[0] ?? '')
  } catch {
    return false
  }
  return !decoded.split(/[\\/]/).includes('..') && !decoded.includes('\0')
}
