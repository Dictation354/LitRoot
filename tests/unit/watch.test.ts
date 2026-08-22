import type { Stats } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RootScanner } from '../../src/main/ingest/scanner.js'

const { chokidarWatchMock } = vi.hoisted(() => ({
  chokidarWatchMock: vi.fn()
}))

vi.mock('chokidar', () => ({
  default: { watch: chokidarWatchMock }
}))

import { RootWatcher } from '../../src/main/ingest/watch.js'

function stats(kind: 'directory' | 'file' | 'symlink'): Stats {
  return {
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink'
  } as unknown as Stats
}

beforeEach(() => {
  vi.useRealTimers()
  chokidarWatchMock.mockReset()
})

describe('RootWatcher traversal policy', () => {
  it('uses the authoritative directory policy without a watcher-only depth limit', () => {
    const watcher = { on: vi.fn(), close: vi.fn() }
    watcher.on.mockImplementation(() => watcher)
    chokidarWatchMock.mockReturnValue(watcher)
    const scanner = { scan: vi.fn() } as unknown as RootScanner
    const rootPath = resolve('fixtures', 'dist')

    new RootWatcher(scanner).watch('root-1', rootPath)

    expect(chokidarWatchMock).toHaveBeenCalledTimes(1)
    const options = chokidarWatchMock.mock.calls[0]?.[1] as {
      depth?: number
      ignored(path: string, stats?: Stats): boolean
    }
    expect(options).not.toHaveProperty('depth')

    const ignoredDirectories = [
      '.git',
      '.hg',
      '.svn',
      '.paper-fetch-locks',
      '.venv',
      'venv',
      'node_modules',
      'http-text-get',
      '__pycache__',
      'dist',
      'out',
      '.cache-paper-fetch'
    ]
    for (const directory of ignoredDirectories) {
      expect(options.ignored(join(rootPath, directory), stats('directory')), directory).toBe(true)
      expect(
        options.ignored(join(rootPath, 'nested', directory, 'article.json'), stats('file')),
        `nested ${directory}`
      ).toBe(true)
    }

    const deepArticle = join(
      rootPath,
      ...Array.from({ length: 30 }, (_, index) => `level-${index}`),
      'article.json'
    )
    expect(options.ignored(rootPath, stats('directory'))).toBe(false)
    expect(options.ignored(deepArticle, stats('file'))).toBe(false)
    expect(options.ignored(join(rootPath, '.cache-paper.json'), stats('file'))).toBe(false)
    expect(options.ignored(join(rootPath, 'notes.txt'), stats('file'))).toBe(true)
    expect(options.ignored(join(rootPath, 'linked-article.json'), stats('symlink'))).toBe(true)
  })

  it('awaits watcher teardown and ignores scheduled or late events after unwatch', async () => {
    vi.useFakeTimers()
    const handlers = new Map<string, (...args: unknown[]) => void>()
    let finishClose!: () => void
    const closePromise = new Promise<void>((resolveClose) => {
      finishClose = resolveClose
    })
    const watcher = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler)
        return watcher
      }),
      close: vi.fn(() => closePromise)
    }
    chokidarWatchMock.mockReturnValue(watcher)
    const scan = vi.fn(() => Promise.resolve())
    const rootWatcher = new RootWatcher({ scan } as unknown as RootScanner)
    const rootPath = resolve('fixtures', 'watch-lifecycle')
    rootWatcher.watch('root-1', rootPath)

    handlers.get('change')?.(join(rootPath, 'article.json'))
    const closing = rootWatcher.unwatch('root-1')
    handlers.get('change')?.(join(rootPath, 'late.json'))
    await vi.advanceTimersByTimeAsync(2_000)

    expect(scan).not.toHaveBeenCalled()
    expect(watcher.close).toHaveBeenCalledTimes(1)
    let settled = false
    void closing.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    finishClose()
    await closing
    expect(settled).toBe(true)
    vi.useRealTimers()
  })

  it('watches directory removal and surfaces active watcher errors', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const watcher = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler)
        return watcher
      }),
      close: vi.fn(() => Promise.resolve())
    }
    chokidarWatchMock.mockReturnValue(watcher)
    const onError = vi.fn()
    const rootWatcher = new RootWatcher({ scan: vi.fn() } as unknown as RootScanner, onError)
    rootWatcher.watch('root-1', resolve('fixtures', 'watch-errors'))

    expect(handlers.has('unlinkDir')).toBe(true)
    const error = new Error('watch descriptor exhausted')
    handlers.get('error')?.(error)
    expect(onError).toHaveBeenCalledWith('root-1', error)

    await rootWatcher.unwatch('root-1')
    handlers.get('error')?.(new Error('late watcher error'))
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
