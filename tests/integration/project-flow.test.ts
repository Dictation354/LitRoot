import { mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ServiceEventBus } from '../../src/service/events.js'
import { initializeProject } from '../../src/service/project-layout.js'
import { LitRootProject } from '../../src/service/project.js'
import { createFakePaperFetch, paperMarkdown, waitFor, writePaper } from '../helpers.js'

const sandboxes: string[] = []

async function fixture() {
  const sandbox = await mkdtemp(join(tmpdir(), 'litroot-project-'))
  sandboxes.push(sandbox)
  const projectPath = join(sandbox, 'project')
  await mkdir(projectPath)
  const fake = await createFakePaperFetch(join(sandbox, 'bin'))
  const layout = await initializeProject(projectPath, 'Test Project')
  const events = new ServiceEventBus()
  const project = new LitRootProject(layout, events, fake)
  return { sandbox, projectPath, layout, project, events }
}

afterEach(async () => {
  for (const path of sandboxes.splice(0).reverse()) await rm(path, { recursive: true, force: true })
})

describe('project lifecycle', () => {
  it('refuses to replace an existing invalid project identity document', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'litroot-invalid-project-'))
    sandboxes.push(sandbox)
    const projectPath = join(sandbox, 'project')
    const litroot = join(projectPath, '.litroot')
    await mkdir(litroot, { recursive: true })
    const invalid = 'schema_version: 2\nproject_id: project_aaaaaaaaaaaaaaaaaaaaaaaa\nname: Future project\n'
    await writeFile(join(litroot, 'project.yaml'), invalid, 'utf8')

    await expect(initializeProject(projectPath)).rejects.toThrow(/project\.yaml.*无效/)
    await expect(readFile(join(litroot, 'project.yaml'), 'utf8')).resolves.toBe(invalid)
  })

  it('initializes the fixed project structure without replacing user files', async () => {
    const { layout, project } = await fixture()
    await expect(readFile(layout.projectFile, 'utf8')).resolves.toContain('schema_version: 1')
    await expect(readFile(join(layout.litroot, '.gitignore'), 'utf8')).resolves.toContain('/cache/')
    await expect(readFile(join(layout.notes, 'project.md'), 'utf8')).resolves.toContain(`project_id: ${layout.id}`)
    await project.start()
    expect(project.summary()).toMatchObject({ name: 'Test Project', status: 'empty', paperCount: 0 })
    await project.close()
  })

  it('cold scans and automatically follows external create, modify and delete events', async () => {
    const { projectPath, project } = await fixture()
    await writePaper(projectPath, 'first.md', paperMarkdown({ title: 'First title', doi: '10.4242/watch' }))
    await project.start()
    expect(project.search({ projectId: project.layout.id, query: 'First' }).total).toBe(1)

    const paperPath = join(projectPath, 'papers', 'first.md')
    await writeFile(paperPath, paperMarkdown({ title: 'Externally changed', doi: '10.4242/watch' }), 'utf8')
    await waitFor(() => project.search({ projectId: project.layout.id, query: 'Externally' }).total === 1)

    await unlink(paperPath)
    await waitFor(() => project.search({ projectId: project.layout.id }).total === 0)
    await project.close()
  })

  it('does not announce a scan when every paper and sidecar is unchanged', async () => {
    const { projectPath, project, events } = await fixture()
    await writePaper(projectPath, 'paper.md', paperMarkdown())
    await project.start()
    const observed: string[] = []
    const unsubscribe = events.subscribe((event) => observed.push(event.type))

    await project.scan()

    expect(observed).not.toContain('scan.started')
    expect(observed).not.toContain('scan.completed')
    unsubscribe()
    await project.close()
  })

  it.each(['doi', 'url'] as const)('settles duplicate %s files without repeated index or sidecar writes', async (identity) => {
    const { projectPath, layout, project, events } = await fixture()
    const firstRaw = paperMarkdown({ title: 'First version', doi: identity === 'doi' ? '10.4242/duplicate' : '' })
    const secondRaw = paperMarkdown({ title: 'Second version', doi: identity === 'doi' ? '10.4242/duplicate' : '' })
    await writePaper(projectPath, 'a.md', firstRaw)
    await writePaper(projectPath, 'b.md', secondRaw)
    let database: DatabaseSync | undefined
    try {
      await project.start()
      expect(project.summary()).toMatchObject({ paperCount: 1, issueCount: 1 })
      const paper = project.search({ projectId: layout.id }).items[0]!
      expect(paper).toMatchObject({ relativePath: 'papers/a.md', title: 'First version' })
      const sidecar = join(layout.metadata, `${paper.id}.yaml`)
      const sidecarBefore = await readFile(sidecar, 'utf8')
      const sidecarStat = await stat(sidecar)
      database = new DatabaseSync(layout.database, { readOnly: true })
      const indexBefore = database.prepare('SELECT relative_path, fingerprint, indexed_at FROM papers').all()
      const issuesBefore = database.prepare('SELECT * FROM issues').all()
      expect(issuesBefore).toEqual([expect.objectContaining({
        relative_path: 'papers/b.md', message: expect.stringContaining('papers/a.md')
      })])
      const observed: string[] = []
      const unsubscribe = events.subscribe((event) => observed.push(event.type))
      try {
        for (let scan = 0; scan < 2; scan += 1) {
          expect(await project.scan()).toMatchObject({ indexed: 0, unchanged: 1, issues: 1 })
        }
        // Cover more than two watcher write-stability/debounce cycles with real filesystem events.
        await new Promise((resolve) => setTimeout(resolve, 3_000))
        expect(observed).toEqual([])
        expect(database.prepare('SELECT relative_path, fingerprint, indexed_at FROM papers').all()).toEqual(indexBefore)
        expect(database.prepare('SELECT * FROM issues').all()).toEqual(issuesBefore)
        expect((await stat(sidecar)).mtimeMs).toBe(sidecarStat.mtimeMs)
        expect(await readFile(sidecar, 'utf8')).toBe(sidecarBefore)
        expect(await readFile(join(layout.papers, 'a.md'), 'utf8')).toBe(firstRaw)
        expect(await readFile(join(layout.papers, 'b.md'), 'utf8')).toBe(secondRaw)
      } finally {
        unsubscribe()
      }
    } finally {
      database?.close()
      await project.close()
    }
  })

  it('keeps the indexed version when an earlier duplicate is added, including restart and cache rebuild', async () => {
    const { projectPath, layout, project } = await fixture()
    await writePaper(projectPath, 'z.md', paperMarkdown({ title: 'Existing version' }))
    let paperId: string
    try {
      await project.start()
      paperId = project.search({ projectId: layout.id }).items[0]!.id
      await writePaper(projectPath, 'a.md', paperMarkdown({ title: 'New duplicate' }))
      await waitFor(() => project.summary().issueCount === 1)
      expect(project.getPaper(paperId)).toMatchObject({ relativePath: 'papers/z.md', title: 'Existing version' })
    } finally {
      await project.close()
    }

    for (const rebuildCache of [false, true]) {
      if (rebuildCache) await rm(layout.cache, { recursive: true, force: true })
      const reopened = new LitRootProject(layout, new ServiceEventBus())
      try {
        await reopened.start()
        expect(reopened.summary()).toMatchObject({ paperCount: 1, issueCount: 1 })
        expect(reopened.getPaper(paperId)).toMatchObject({ relativePath: 'papers/z.md', title: 'Existing version' })
        expect(await reopened.scan()).toMatchObject({ indexed: 0, unchanged: 1, issues: 1 })
      } finally {
        await reopened.close()
      }
    }
  })

  it('prefers the indexed path over a conflicting metadata source path', async () => {
    const { projectPath, layout, project } = await fixture()
    await writePaper(projectPath, 'z.md', paperMarkdown({ title: 'Indexed version' }))
    let paperId: string
    try {
      await project.start()
      paperId = project.search({ projectId: layout.id }).items[0]!.id
    } finally {
      await project.close()
    }
    await writePaper(projectPath, 'a.md', paperMarkdown({ title: 'Duplicate version' }))
    const sidecar = join(layout.metadata, `${paperId}.yaml`)
    await writeFile(sidecar, (await readFile(sidecar, 'utf8')).replace('papers/z.md', 'papers/a.md'))
    const reopened = new LitRootProject(layout, new ServiceEventBus())
    try {
      await reopened.start()
      expect(reopened.summary()).toMatchObject({ paperCount: 1, issueCount: 1 })
      expect(reopened.getPaper(paperId)).toMatchObject({ relativePath: 'papers/z.md', title: 'Indexed version' })
    } finally {
      await reopened.close()
    }
  })

  it('updates the retained version, clears removed conflicts and preserves identity when a duplicate takes over', async () => {
    const { projectPath, layout, project } = await fixture()
    const original = join(layout.papers, 'z.md')
    const duplicate = join(layout.papers, 'a.md')
    const duplicateRaw = paperMarkdown({ title: 'Duplicate version' })
    await writePaper(projectPath, 'z.md', paperMarkdown({ title: 'Original version' }))
    try {
      await project.start()
      const paperId = project.search({ projectId: layout.id }).items[0]!.id
      const note = await project.readNote('paper', paperId)
      await project.writeNote('paper', 'Keep this note.', note.revision, paperId)
      await project.updateMetadata({ projectId: layout.id, paperId, patch: { journal: 'My journal' } })
      await writeFile(duplicate, duplicateRaw)
      await waitFor(() => project.summary().issueCount === 1)

      await writeFile(original, paperMarkdown({ title: 'Updated original' }))
      await waitFor(() => project.getPaper(paperId)?.title === 'Updated original')
      expect(project.getPaper(paperId)?.relativePath).toBe('papers/z.md')

      await unlink(duplicate)
      await waitFor(() => project.summary().issueCount === 0)
      await writeFile(duplicate, duplicateRaw)
      await waitFor(() => project.summary().issueCount === 1)
      await unlink(original)
      await waitFor(() => project.getPaper(paperId)?.relativePath === 'papers/a.md')
      expect(project.summary()).toMatchObject({ paperCount: 1, issueCount: 0 })
      expect(project.getPaper(paperId)).toMatchObject({ title: 'Duplicate version', journal: 'My journal' })
      expect((await project.readNote('paper', paperId)).content).toContain('Keep this note.')
      expect(await readFile(join(layout.metadata, `${paperId}.yaml`), 'utf8')).toContain('source_path: papers/a.md')
      expect(await project.scan()).toMatchObject({ indexed: 0, unchanged: 1, issues: 0 })
    } finally {
      await project.close()
    }
  })

  it('does not replace an existing invalid owner with a duplicate or repeatedly announce its errors', async () => {
    const { projectPath, layout, project, events } = await fixture()
    await writePaper(projectPath, 'z.md', paperMarkdown())
    try {
      await project.start()
      await writePaper(projectPath, 'a.md', paperMarkdown({ title: 'Duplicate version' }))
      await writeFile(join(layout.papers, 'z.md'), '---\ntitle: Unclosed frontmatter')
      await project.scan()
      expect(project.summary()).toMatchObject({ paperCount: 0, issueCount: 2 })
      const observed: string[] = []
      const unsubscribe = events.subscribe((event) => observed.push(event.type))
      try {
        expect(await project.scan()).toMatchObject({ indexed: 0, issues: 2 })
        expect(observed).toEqual([])
      } finally {
        unsubscribe()
      }
    } finally {
      await project.close()
    }
  })

  it('persists metadata overrides, stable paper ID and note files across restart', async () => {
    const { projectPath, layout, project } = await fixture()
    await writePaper(projectPath, 'paper.md', paperMarkdown({ title: 'Fetched title', doi: '10.4242/original' }))
    await project.start()
    const first = project.search({ projectId: layout.id }).items[0]
    if (!first) throw new Error('Expected scanned paper.')
    const updated = await project.updateMetadata({
      projectId: layout.id,
      paperId: first.id,
      patch: { title: 'Corrected title', doi: '10.4242/corrected' }
    })
    expect(updated.id).toBe(first.id)
    const note = await project.readNote('paper', first.id)
    const saved = await project.writeNote('paper', 'A durable project-owned note.', note.revision, first.id)
    expect(saved.content).toContain('durable')
    await project.updateMetadata({
      projectId: layout.id,
      paperId: first.id,
      patch: { title: 'A later title' }
    })
    await project.writeNote('paper', 'Second note revision.', saved.revision, first.id)
    expect(await readFile(saved.path, 'utf8')).toContain('title_on_create: Corrected title')
    await project.close()
    await rm(layout.cache, { recursive: true, force: true })

    const reopened = new LitRootProject(layout, new ServiceEventBus())
    await reopened.start()
    const found = reopened.search({ projectId: layout.id, query: 'later title' }).items[0]
    expect(found).toMatchObject({ id: first.id, doi: '10.4242/corrected' })
    expect((await reopened.readNote('paper', first.id)).content).toContain('Second note revision')
    await reopened.close()
  })

  it('reindexes a metadata sidecar edited by an external Agent', async () => {
    const { projectPath, project } = await fixture()
    await writePaper(projectPath, 'paper.md', paperMarkdown({ doi: '10.4242/sidecar' }))
    await project.start()
    const paper = project.search({ projectId: project.layout.id }).items[0]
    if (!paper) throw new Error('Expected scanned paper.')
    const sidecar = join(project.layout.metadata, `${paper.id}.yaml`)
    const raw = await readFile(sidecar, 'utf8')
    await writeFile(sidecar, raw.replace('overrides: {}', 'overrides:\n  title: External sidecar title'), 'utf8')
    await waitFor(() => project.search({ projectId: project.layout.id, query: 'External sidecar' }).total === 1)
    await project.close()
  })

  it('stops note autosave on an external revision conflict', async () => {
    const { projectPath, project } = await fixture()
    await writePaper(projectPath, 'paper.md', paperMarkdown())
    await project.start()
    const paper = project.search({ projectId: project.layout.id }).items[0]
    if (!paper) throw new Error('Expected scanned paper.')
    const note = await project.readNote('paper', paper.id)
    await writeFile(note.path, `${await readFile(note.path, 'utf8')}\nExternal agent edit.`, 'utf8')
    await expect(project.writeNote('paper', 'Unsaved GUI draft.', note.revision, paper.id)).rejects.toMatchObject({ code: 'note_conflict' })
    expect(await readFile(note.path, 'utf8')).toContain('External agent edit')
    await project.close()
  })

  it('rejects an image symlink that escapes the project', async () => {
    const { sandbox, projectPath, project } = await fixture()
    await mkdir(join(projectPath, 'papers', 'assets'), { recursive: true })
    const outside = join(sandbox, 'outside.png')
    await writeFile(outside, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    await symlink(outside, join(projectPath, 'papers', 'assets', 'escape.png'))
    await writePaper(projectPath, 'paper.md', paperMarkdown({ body: '![Escape](assets/escape.png)' }))
    await project.start()
    const paper = project.search({ projectId: project.layout.id }).items[0]
    if (!paper) throw new Error('Expected scanned paper.')
    await expect(project.readAsset(paper.id, 'assets/escape.png')).resolves.toBeNull()
    await project.close()
  })

  it('exports original Markdown with optional validated images and confirms conflicts', async () => {
    const { sandbox, projectPath, project } = await fixture()
    await mkdir(join(projectPath, 'papers', 'assets'), { recursive: true })
    await writeFile(
      join(projectPath, 'papers', 'assets', 'figure.png'),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
    const raw = paperMarkdown({ body: '![Figure](assets/figure.png)' })
    await writePaper(projectPath, 'paper.md', raw)
    await project.start()
    const paper = project.search({ projectId: project.layout.id }).items[0]
    if (!paper) throw new Error('Expected scanned paper.')

    const textDestination = join(sandbox, 'text-export')
    await mkdir(textDestination)
    const textPlan = await project.planExport({
      projectId: project.layout.id,
      paperIds: [paper.id],
      destination: textDestination,
      includeImages: false
    })
    expect(textPlan).toEqual({ files: ['papers/paper.md'], conflicts: [] })
    const textResult = await project.exportPapers({
      projectId: project.layout.id,
      paperIds: [paper.id],
      destination: textDestination,
      includeImages: false,
      approvedConflicts: []
    })
    expect(textResult).toMatchObject({ papers: 1, images: 0, failures: [] })
    await expect(readFile(join(textDestination, 'papers', 'paper.md'), 'utf8')).resolves.toBe(raw)

    const imageDestination = join(sandbox, 'image-export')
    await mkdir(imageDestination)
    const imageResult = await project.exportPapers({
      projectId: project.layout.id,
      paperIds: [paper.id],
      destination: imageDestination,
      includeImages: true,
      approvedConflicts: []
    })
    expect(imageResult).toMatchObject({ papers: 1, images: 1, failures: [] })
    await expect(readFile(join(imageDestination, 'papers', 'assets', 'figure.png'))).resolves.toHaveLength(8)
    await expect(project.planExport({
      projectId: project.layout.id,
      paperIds: [paper.id],
      destination: imageDestination,
      includeImages: true
    })).resolves.toMatchObject({
      conflicts: ['papers/assets/figure.png', 'papers/paper.md']
    })

    const unsafeDestination = join(sandbox, 'unsafe-export')
    const outside = join(sandbox, 'outside-export')
    await mkdir(unsafeDestination)
    await mkdir(outside)
    await symlink(outside, join(unsafeDestination, 'papers'))
    await expect(project.planExport({
      projectId: project.layout.id,
      paperIds: [paper.id],
      destination: unsafeDestination,
      includeImages: false
    })).rejects.toMatchObject({ code: 'unsafe_export_target' })
    await project.close()
  })
})
