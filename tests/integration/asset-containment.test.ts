import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { readAssetPreview } from '../../src/main/asset-preview.js'
import { LibraryDatabase } from '../../src/main/db/library-database.js'
import { RootScanner } from '../../src/main/ingest/scanner.js'

interface Fixture {
  sandboxPath: string
  rootPath: string
  database: LibraryDatabase
  scanner: RootScanner
}

const fixtures: Fixture[] = []

function articleWithAssets(paths: string[]): string {
  return JSON.stringify({
    doi: '10.4242/asset-containment',
    source: 'publisher_html',
    metadata: {
      title: 'Canonical Asset Containment',
      authors: ['Ada Researcher'],
      abstract: 'Asset previews remain inside their registered research root.',
      published: '2026-08-19'
    },
    sections: [
      {
        heading: 'Results',
        level: 1,
        kind: 'results',
        text: 'The asset containment result is reproducible.'
      }
    ],
    references: [],
    assets: paths.map((path, index) => ({
      kind: 'figure',
      heading: `Figure ${index + 1}`,
      path
    })),
    quality: {
      has_fulltext: true,
      has_abstract: true,
      content_kind: 'fulltext',
      warnings: [],
      extraction_revision: 1
    }
  })
}

async function createFixture(assetPaths: string[]): Promise<Fixture> {
  const sandboxPath = await mkdtemp(join(tmpdir(), 'paperrelay-asset-containment-'))
  const rootPath = join(sandboxPath, 'research-root')
  await mkdir(rootPath, { recursive: true })
  await writeFile(join(rootPath, 'article.json'), articleWithAssets(assetPaths), 'utf8')
  const database = new LibraryDatabase(join(sandboxPath, 'state', 'paperrelay.sqlite3'))
  const fixture = { sandboxPath, rootPath, database, scanner: new RootScanner(database) }
  fixtures.push(fixture)
  return fixture
}

async function scanFixture(fixture: Fixture): Promise<string> {
  const root = fixture.database.registerRoot(await realpath(fixture.rootPath), 'Asset containment')
  await fixture.scanner.scan(root.id)
  const paperId = fixture.database.searchPapers({})[0]?.id
  if (!paperId) throw new Error('Expected the asset fixture paper to be indexed.')
  return paperId
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    fixture.database.close()
    await rm(fixture.sandboxPath, { recursive: true, force: true })
  }
})

describe('asset containment', () => {
  it('rejects an in-root symlink whose target is outside while preserving an in-root target', async () => {
    const fixture = await createFixture(['outside-link.png', 'inside-link.png'])
    const outsideTarget = join(fixture.sandboxPath, 'outside.png')
    const insideTarget = join(fixture.rootPath, 'inside.png')
    await writeFile(outsideTarget, new Uint8Array([137, 80, 78, 71, 1]))
    await writeFile(insideTarget, new Uint8Array([137, 80, 78, 71, 2]))
    await symlink(
      outsideTarget,
      join(fixture.rootPath, 'outside-link.png'),
      process.platform === 'win32' ? 'file' : undefined
    )
    await symlink(
      insideTarget,
      join(fixture.rootPath, 'inside-link.png'),
      process.platform === 'win32' ? 'file' : undefined
    )

    const paperId = await scanFixture(fixture)
    const paper = fixture.database.getPaper(paperId)

    expect(paper?.assets[0]).toMatchObject({ path: null, available: false, previewUrl: null })
    expect(fixture.database.resolveAssetPath(paperId, 0)).toBeNull()
    expect(paper?.assets[1]).toMatchObject({
      path: await realpath(insideTarget),
      available: true
    })
    expect(paper?.assets[1]?.previewUrl).toContain('paperrelay-asset://preview/')
    expect(fixture.database.resolveAssetPath(paperId, 1)).toBe(await realpath(insideTarget))
  })

  it('resolves symlinked parent directories before applying containment', async () => {
    const fixture = await createFixture([
      'outside-directory-link/figure.png',
      'inside-directory-link/figure.png'
    ])
    const outsideDirectory = join(fixture.sandboxPath, 'outside-assets')
    const insideDirectory = join(fixture.rootPath, 'inside-assets')
    await mkdir(outsideDirectory, { recursive: true })
    await mkdir(insideDirectory, { recursive: true })
    const outsideTarget = join(outsideDirectory, 'figure.png')
    const insideTarget = join(insideDirectory, 'figure.png')
    await writeFile(outsideTarget, new Uint8Array([137, 80, 78, 71, 5]))
    await writeFile(insideTarget, new Uint8Array([137, 80, 78, 71, 6]))
    await symlink(
      outsideDirectory,
      join(fixture.rootPath, 'outside-directory-link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await symlink(
      insideDirectory,
      join(fixture.rootPath, 'inside-directory-link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    const paperId = await scanFixture(fixture)
    const paper = fixture.database.getPaper(paperId)

    expect(paper?.assets[0]).toMatchObject({ path: null, available: false, previewUrl: null })
    expect(fixture.database.resolveAssetPath(paperId, 0)).toBeNull()
    expect(paper?.assets[1]).toMatchObject({
      path: await realpath(insideTarget),
      available: true
    })
    expect(fixture.database.resolveAssetPath(paperId, 1)).toBe(await realpath(insideTarget))
  })

  it('returns a controlled miss when an asset disappears or becomes a symlink after lookup', async () => {
    const fixture = await createFixture(['figure.png'])
    const assetPath = join(fixture.rootPath, 'figure.png')
    const outsideTarget = join(fixture.sandboxPath, 'replacement.png')
    await writeFile(assetPath, new Uint8Array([137, 80, 78, 71, 3]))
    await writeFile(outsideTarget, new Uint8Array([137, 80, 78, 71, 4]))
    const paperId = await scanFixture(fixture)
    const resolvedPath = fixture.database.resolveAssetPath(paperId, 0)
    if (!resolvedPath) throw new Error('Expected the in-root asset to resolve before deletion.')

    await expect(readAssetPreview(resolvedPath)).resolves.toMatchObject({
      ok: true,
      contentType: 'image/png'
    })

    await unlink(assetPath)
    expect(fixture.database.resolveAssetPath(paperId, 0)).toBeNull()
    expect(fixture.database.getPaper(paperId)?.assets[0]).toMatchObject({
      path: null,
      available: false,
      previewUrl: null
    })
    await expect(readAssetPreview(resolvedPath)).resolves.toEqual({
      ok: false,
      status: 404,
      message: 'Asset not found.'
    })

    await symlink(
      outsideTarget,
      assetPath,
      process.platform === 'win32' ? 'file' : undefined
    )
    expect(fixture.database.resolveAssetPath(paperId, 0)).toBeNull()
    await expect(readAssetPreview(resolvedPath)).resolves.toMatchObject({ ok: false, status: 404 })
  })
})
