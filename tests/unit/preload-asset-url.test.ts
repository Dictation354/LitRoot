import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { paperAssetUrl } from '../../src/preload/asset-url.js'

describe('preload paper asset URL', () => {
  it('encodes Unicode paths as unpadded URL-safe Base64', () => {
    const request = {
      projectId: 'project_aaaaaaaaaaaaaaaaaaaaaaaa',
      paperId: 'paper_bbbbbbbbbbbbbbbbbbbbbbbb',
      source: 'figures/结果 ①.png'
    }
    const url = paperAssetUrl(request.projectId, request.paperId, request.source)
    const prefix = 'litroot-asset://paper/'
    const payload = url.slice(prefix.length)

    expect(url.startsWith(prefix)).toBe(true)
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toEqual(request)
  })
})
