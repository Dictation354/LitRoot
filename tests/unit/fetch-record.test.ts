import { describe, expect, it } from 'vitest'
import {
  actionRequired,
  itemFor,
  parseJsonLines,
  parseManifestDocument,
  parseTerminalRecord
} from '../../src/service/fetch-record.js'

describe('paper-fetch record parsing', () => {
  it('reads current schema-v2 terminal records and nested failure statuses', () => {
    const record = parseTerminalRecord({
      schema_version: 2,
      index: 2,
      record_status: 'completed',
      error: null,
      source: 'publisher',
      acceptance: {
        overall: 'complete',
        identity: { doi: '10.4242/current', title: 'Current paper', canonical_landing_url: 'https://example.test/current' },
        content: { status: 'fulltext', has_fulltext: true }
      },
      output_artifacts: [{ kind: 'primary_markdown', path: '/tmp/current.md', sha256: 'ABC123' }]
    })
    expect(record).toMatchObject({
      index: 2, status: 'ok', canonicalDoi: '10.4242/current', title: 'Current paper',
      canonicalUrl: 'https://example.test/current', provider: 'publisher',
      contentKind: 'fulltext', outputPath: '/tmp/current.md', outputSha256: 'ABC123'
    })
    const failure = parseTerminalRecord({
      record_status: 'failed', error: { status: 'no_access', reason: 'Authentication required' }
    })!
    expect(failure.status).toBe('no_access')
    expect(actionRequired(failure)).toBe(true)
    expect(parseTerminalRecord({
      record_status: 'aborted', error: { status: 'aborted', code: 'request_cancelled' }
    })?.status).toBe('cancelled')
  })

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
