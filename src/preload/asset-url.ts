function toUrlSafeBase64(base64: string): string {
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '')
}

export function paperAssetUrl(projectId: string, paperId: string, source: string): string {
  const request = JSON.stringify({ projectId, paperId, source })
  const payload = toUrlSafeBase64(Buffer.from(request, 'utf8').toString('base64'))
  return `litroot-asset://paper/${payload}`
}
