export function supportedNode(version: string | null): boolean {
  if (!version) return false
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  return Boolean(match && Number(match[1]) === 24 && (
    Number(match[2]) > 15 || (Number(match[2]) === 15 && Number(match[3]) >= 0)
  ))
}
