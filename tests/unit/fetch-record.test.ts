import { describe, expect, it } from 'vitest'
import {
  actionRequired,
  itemFor,
  parseJsonLines,
  parseManifestDocument,
  parseTerminalRecord
} from '../../src/service/fetch-record.js'

describe('paper-fetch record parsing', () => {
  it('reads compatible nested identity, output artifact, error, and acceptance fields', () => {
    const record = parseTerminalRecord({
      index: 2,
      attempt: 3,
      status: 'ok',
      acceptance: {
        overall: 'degraded',
        identity: { canonical_doi: 'https://doi.org/10.4242/Record', url: 'https://example.test/paper' },
        content: { content_kind: 'fulltext' }
      },
      error: { error_category: 'asset_missing', reason: 'One image is missing' },
      output_artifacts: [{ kind: 'markdown', path: '/tmp/paper.md', sha256: 'ABC123' }]
    })

    expect(record).toMatchObject({
      index: 2,
      attempt: 3,
      canonicalDoi: '10.4242/record',
      canonicalUrl: 'https://example.test/paper',
      reason: 'One image is missing',
      errorCode: 'asset_missing',
      acceptance: 'degraded',
      contentKind: 'fulltext',
      outputPath: '/tmp/paper.md',
      outputSha256: 'ABC123'
    })
  })

  it('ignores malformed JSONL lines, parses JSON/YAML manifests, and classifies action-required states', () => {
    expect(parseJsonLines('{"status":"ok"}\nnot-json\n{"status":"failed"}\n')).toHaveLength(2)
    expect(parseManifestDocument('{"results":[{"status":"ok"}]}')).toEqual([{ status: 'ok' }])
    expect(parseManifestDocument('- status: ambiguous\n')).toEqual([{ status: 'ambiguous' }])
    const record = parseTerminalRecord({ status: 'challenge', provider: 'test' })!
    expect(actionRequired(record)).toBe(true)
    expect(itemFor(1, 'https://doi.org/10.4242/Seed')).toMatchObject({
      index: 1,
      canonicalDoi: '10.4242/seed',
      stage: 'queued',
      state: 'pending'
    })
  })
})
