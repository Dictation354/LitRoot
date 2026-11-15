import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { MetadataOverrides, ScanResult } from '../../src/shared/contracts.js'
import { ServiceEventBus } from '../../src/service/events.js'
import { sha256 } from '../../src/service/identity.js'
import { initializeProject } from '../../src/service/project-layout.js'
import { LitRootProject } from '../../src/service/project.js'
import { writePaper } from '../helpers.js'

const goldenUrl = new URL('../fixtures/paper-fetch-7.6.2/extracted.md', import.meta.url)

describe('paper-fetch 7.6.2 publication years', () => {
  it('imports the real golden into the SQLite year column, FTS and library filters', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'litroot-fetch-762-'))
    let project: LitRootProject | undefined
    let database: DatabaseSync | undefined
    try {
      const layout = await initializeProject(sandbox)
      const raw = await readFile(goldenUrl, 'utf8')
      const path = await writePaper(sandbox, 'golden.md', raw)
      project = new LitRootProject(layout, new ServiceEventBus())
      await project.start()

      const result = project.search({ projectId: layout.id })
      expect(result.total).toBe(1)
      expect(result.items[0]).toMatchObject({ year: 2022, doi: '10.1038/s41561-022-00974-7' })
      expect(result.years).toEqual([2022])
      expect(project.summary().years).toEqual([2022])
      expect(project.search({ projectId: layout.id, year: 2022 }).total).toBe(1)
      expect(project.search({ projectId: layout.id, year: 2021 }).total).toBe(0)

      database = new DatabaseSync(layout.database, { readOnly: true })
      expect(database.prepare('SELECT year FROM papers').get()).toMatchObject({ year: 2022 })
      expect(database.prepare("SELECT paper_id FROM paper_fts WHERE paper_fts MATCH 'year:2022'").all())
        .toEqual([expect.objectContaining({ paper_id: result.items[0]!.id })])
      expect(await readFile(path, 'utf8')).toBe(raw)
    } finally {
      database?.close()
      await project?.close()
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it.each([
    { name: 'inherited year', overrides: {} as MetadataOverrides, year: 2022 },
    { name: 'numeric year override', overrides: { year: 2024 } as MetadataOverrides, year: 2024 },
    { name: 'explicitly cleared year', overrides: { year: '' } as MetadataOverrides, year: null }
  ])('refreshes a legacy cache on restart and preserves $name', async ({ overrides, year }) => {
    const sandbox = await mkdtemp(join(tmpdir(), 'litroot-fetch-762-cache-'))
    let project: LitRootProject | undefined
    let database: DatabaseSync | undefined
    try {
      const layout = await initializeProject(sandbox)
      const raw = await readFile(goldenUrl, 'utf8')
      const path = await writePaper(sandbox, 'golden.md', raw)
      project = new LitRootProject(layout, new ServiceEventBus())
      await project.start()
      const id = project.search({ projectId: layout.id }).items[0]!.id
      if (Object.keys(overrides).length) {
        await project.updateMetadata({ projectId: layout.id, paperId: id, patch: overrides })
      }
      const body = project.getPaper(id)!.markdown
      const sidecarPath = join(layout.metadata, `${id}.yaml`)
      await project.close()
      project = undefined
      const sidecar = await readFile(sidecarPath, 'utf8')

      // Reproduce the old parser's missing fetched year and unversioned fingerprint.
      database = new DatabaseSync(layout.database)
      const cached = database.prepare('SELECT added_at, fetched_metadata_json FROM papers WHERE id = ?')
        .get(id) as { added_at: string | null; fetched_metadata_json: string }
      const legacyFingerprint = sha256(`${raw}\0${JSON.stringify(overrides)}\0${cached.added_at ?? ''}`)
      const fetched = { ...JSON.parse(cached.fetched_metadata_json), year: null }
      const legacyYear = overrides.year === '' ? null : overrides.year ?? null
      database.prepare('UPDATE papers SET fingerprint = ?, fetched_metadata_json = ?, year = ? WHERE id = ?')
        .run(legacyFingerprint, JSON.stringify(fetched), legacyYear, id)
      database.prepare('UPDATE paper_fts SET year = ? WHERE paper_id = ?').run(legacyYear ?? '', id)
      expect(database.prepare('SELECT year FROM papers').get()).toMatchObject({ year: legacyYear })
      database.close()
      database = undefined

      const scans: ScanResult[] = []
      const events = new ServiceEventBus()
      const unsubscribe = events.subscribe((event) => {
        if (event.type === 'scan.completed') scans.push(event.result)
      })
      project = new LitRootProject(layout, events)
      await project.start()
      unsubscribe()
      expect(scans).toHaveLength(1)
      expect(scans[0]).toMatchObject({ indexed: 1, unchanged: 0, issues: 0 })
      expect(project.getPaper(id)).toMatchObject({
        id, year, fetchedMetadata: { year: 2022 }, overrides, markdown: body
      })
      const result = project.search({ projectId: layout.id })
      expect(result.items.map((paper) => ({ id: paper.id, year: paper.year }))).toEqual([{ id, year }])
      expect(result.years).toEqual(year === null ? [] : [year])
      expect(project.search({ projectId: layout.id, year: 2022 }).total).toBe(year === 2022 ? 1 : 0)
      if (year !== null) expect(project.search({ projectId: layout.id, year }).total).toBe(1)

      database = new DatabaseSync(layout.database, { readOnly: true })
      expect(database.prepare('SELECT id, year, raw_markdown FROM papers').get())
        .toMatchObject({ id, year, raw_markdown: raw })
      expect(database.prepare('SELECT year FROM paper_fts WHERE paper_id = ?').get(id))
        .toMatchObject({ year: year ?? '' })
      const index = database.prepare('SELECT fingerprint, indexed_at FROM papers').get()
      expect(index).not.toMatchObject({ fingerprint: legacyFingerprint })
      expect(await project.scan()).toMatchObject({ indexed: 0, unchanged: 1, issues: 0 })
      expect(database.prepare('SELECT fingerprint, indexed_at FROM papers').get()).toEqual(index)
      expect(await readFile(sidecarPath, 'utf8')).toBe(sidecar)
      expect(await readFile(path, 'utf8')).toBe(raw)
    } finally {
      database?.close()
      await project?.close()
      await rm(sandbox, { recursive: true, force: true })
    }
  })
})
