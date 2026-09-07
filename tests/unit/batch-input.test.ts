import { describe, expect, it } from 'vitest'
import { parseBatchInput } from '../../src/shared/batch-input.js'
import { createFetchRunRequestSchema, fetchRunSchema } from '../../src/shared/contracts.js'
import { itemFor } from '../../src/service/fetch-record.js'

describe('batch input', () => {
  it('preserves order and duplicate entries while normalizing whitespace', () => {
    expect(parseBatchInput(' first  title \n\n10.1/test\n first  title ').inputs).toEqual([
      'first title', '10.1/test', 'first title'
    ])
  })

  it.each([51, 500])('accepts %i items for input, refresh requests and saved runs', (count) => {
    const inputs = Array.from({ length: count }, (_, index) => `paper ${index}`)
    expect(parseBatchInput(inputs.join('\n')).inputs).toEqual(inputs)
    const refreshPaperIds = inputs.map((_, index) => `paper_${index}`)
    const request = createFetchRunRequestSchema.parse({ projectId: 'project_test', inputs, refreshPaperIds })
    expect(request.inputs).toEqual(inputs)
    const run = fetchRunSchema.parse({
      schemaVersion: 1, id: 'run_test', projectId: request.projectId, state: 'queued',
      concurrency: request.concurrency, refreshPaperId: null, refreshPaperIds,
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      manifestPath: '/tmp/run_test.litroot.json',
      executionIndexes: inputs.map((_, index) => index + 1),
      items: inputs.map((input, index) => itemFor(index + 1, input))
    })
    expect(run.items.map((item) => item.query)).toEqual(inputs)
    expect(run.refreshPaperIds).toEqual(refreshPaperIds)
    expect(run.executionIndexes).toHaveLength(count)
  })
})
