import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const project = new LitRootProject(layout, new ServiceEventBus(), fake)
  return { sandbox, projectPath, layout, project }
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
})
