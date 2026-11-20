import { describe, expect, it } from 'vitest'
import {
  actionRequired,
  itemFor,
  parseJsonLines,
  parseManifestDocument,
  parseTerminalRecord
} from '../../src/service/fetch-record.js'

describe('paper-fetch record parsing', () => {
  it.each([1, 2])('reads schema-v%i receipts and prefers primary Markdown over the internal body snapshot', (schemaVersion) => {
    const receipt = {
      schema_version: schemaVersion, contract: 'paper-fetch/receipt', index: 2, status: 'completed',
      identity: { doi: '10.4242/receipt', title: 'Receipt paper', canonical_landing_url: 'https://example.test/receipt' },
      acceptance: { overall: 'degraded', identity: 'resolved', content: 'fulltext',
        asset_summary: { local: 1, not_archived: 1 } },
      content_kind: 'fulltext', warning_codes: ['asset_not_archived'],
      body_path: '/tmp/.paper-fetch-results/run/2/body.md',
      manifest_path: '/tmp/.paper-fetch-results/run/2/manifest.json',
      output_paths: ['/tmp/paper.json', '/tmp/paper.md']
    }
    expect(parseTerminalRecord(receipt)).toMatchObject({
      index: 2, status: 'completed', title: 'Receipt paper', canonicalDoi: '10.4242/receipt',
      canonicalUrl: 'https://example.test/receipt', outputPath: '/tmp/paper.md',
      acceptance: 'degraded', contentKind: 'fulltext',
      diagnostics: { assetSummary: { local: 1, not_archived: 1 }, warningCodes: ['asset_not_archived'] }
    })
    expect(parseTerminalRecord({ ...receipt, output_paths: ['/tmp/paper.json'] })?.outputPath).toBe(receipt.body_path)
    expect(parseTerminalRecord({ ...receipt, contract: 'unrelated' })?.outputPath).toBeNull()
  })

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
      canonicalUrl: 'https://example.test/current', provider: null, source: 'publisher',
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

it('uses error and acquisition provider fields without treating source as a provider', () => {
  const base = { source: 'wiley_browser', acquisition: { provider: 'wiley' }, provider: 'legacy', error: { provider: 'science', status: 'auth_required', code: 'explicit' } }
  expect(parseTerminalRecord(base)).toMatchObject({ provider: 'science', source: 'wiley_browser', errorCode: 'explicit' })
  expect(parseTerminalRecord({ ...base, error: null })?.provider).toBe('wiley')
  expect(parseTerminalRecord({ source: 'wiley_browser' })?.provider).toBeNull()
  expect(parseTerminalRecord({ completion_order: 8 })?.completionOrder).toBeNull()
})

it.each([[2, '7.0.1'], [3, '8.0.0']])('classifies schema-v%i batch aborts by their structured evidence', (schemaVersion, toolVersion) => {
  const timestamp = '2026-09-02T02:00:00Z'
  const error = { status: 'aborted', code: 'rate_limited', reason: 'Provider lane stopped', retry_after_seconds: 7 }
  const aborted = {
    schema_version: schemaVersion, tool_version: toolVersion, record_status: 'aborted',
    started_at: timestamp, completed_at: timestamp, acceptance: { overall: 'action_required' }, error
  }

  expect(parseTerminalRecord(aborted, 1, true)).toMatchObject({
    status: 'not_scheduled', reason: error.reason, errorCode: error.code, diagnostics: { retryAfterSeconds: 7 }
  })
  expect(parseTerminalRecord({ ...aborted, error: { ...error, code: 'request_cancelled' } }, 1, true)?.status).toBe('cancelled')
  expect(parseTerminalRecord(aborted)?.status).toBe('failed')
  for (const overrides of [
    { completed_at: '2026-09-02T02:00:01Z' },
    { started_at: null, completed_at: null },
    { error: null },
    { error: { status: 'aborted', code: 'rate_limited' } },
    { error: { ...error, code: 'unknown' } },
    { error: { ...error, status: 'rate_limited' } }
  ]) {
    const record = parseTerminalRecord({ ...aborted, ...overrides }, 1, true)!
    expect(record.status).toBe('failed')
    expect(actionRequired(record)).toBe(false)
  }
})

it('prefers nested content semantic losses and retains legacy top-level counts', () => {
  const legacy = { table_fallback_count: 2, formula_fallback_count: 4 }
  const losses = { table_semantic_loss_count: 1, formula_missing_count: 3 }
  expect(parseTerminalRecord({ schema_version: 2, semantic_losses: legacy })?.diagnostics?.semanticLosses).toEqual(legacy)
  expect(parseTerminalRecord({
    schema_version: 3, acceptance: { content: { semantic_losses: losses } }, semantic_losses: legacy
  })?.diagnostics?.semanticLosses).toEqual(losses)
})
