import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ServiceEventBus } from '../../src/service/events.js'
import type { ProjectLayout } from '../../src/service/project-layout.js'
import type { ProjectScanner } from '../../src/service/scanner.js'
import { ProjectWatcher } from '../../src/service/watcher.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (path) => rm(path, { recursive: true, force: true })
  ))
})

describe('project note watcher debounce', () => {
  it('emits every changed note path collected in one debounce window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'litroot-watcher-'))
    temporaryDirectories.push(root)
    const notes = join(root, 'notes')
    const paperNotes = join(notes, 'papers')
    await mkdir(paperNotes, { recursive: true })
    const projectNote = join(notes, 'project.md')
    const paperId = 'paper_aaaaaaaaaaaaaaaaaaaaaaaa'
    const paperNote = join(paperNotes, `${paperId}.md`)
    await writeFile(projectNote, 'Project note')
    await writeFile(paperNote, 'Paper note')

    const events = new ServiceEventBus()
    const observed: Array<{ kind: string; paperId: string | null }> = []
    events.subscribe((event) => {
      if (event.type === 'note.changed') observed.push({ kind: event.kind, paperId: event.paperId })
    })
    const layout = {
      id: 'project_bbbbbbbbbbbbbbbbbbbbbbbb',
      notes
    } as ProjectLayout
    const watcher = new ProjectWatcher(layout, {} as ProjectScanner, events)
    const scheduleNote = Reflect.get(watcher, 'scheduleNote') as (path: string) => void

    scheduleNote.call(watcher, projectNote)
    scheduleNote.call(watcher, paperNote)
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(observed).toEqual(expect.arrayContaining([
      { kind: 'project', paperId: null },
      { kind: 'paper', paperId }
    ]))
    expect(observed).toHaveLength(2)
    await watcher.close()
  })
})
