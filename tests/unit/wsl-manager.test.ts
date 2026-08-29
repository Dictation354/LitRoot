import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/tmp/litroot-test',
    getPath: () => '/tmp/litroot-user-data'
  }
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnMock }
})

import { ServiceRuntimeManager, windowsPaperFetchCommand } from '../../src/main/wsl-manager.js'

class FakeReadable extends EventEmitter {
  setEncoding(): this {
    return this
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new FakeReadable()
  readonly stderr = new FakeReadable()
  exitCode: number | null = null
  killed = false

  kill(): boolean {
    if (this.exitCode !== null) return false
    this.killed = true
    this.exitCode = 0
    this.emit('exit', 0, null)
    return true
  }

  ready(port: number): void {
    this.stdout.emit('data', `${JSON.stringify({ type: 'ready', port })}\n`)
  }

  fail(message: string): void {
    this.stderr.emit('data', message)
    this.exitCode = 1
    this.emit('exit', 1, null)
  }
}

const target = { kind: 'local' } as const
let children: FakeChildProcess[] = []

beforeEach(() => {
  vi.stubEnv('PAPER_FETCH_BIN', '/bin/true')
  children = []
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => {
    const child = new FakeChildProcess()
    children.push(child)
    return child as unknown as ChildProcess
  })
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('event stream stopped in test')
  }))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('service runtime startup', () => {
  it('shares one in-flight startup per runtime', async () => {
    const manager = new ServiceRuntimeManager(() => undefined)
    const first = manager.client(target)
    const second = manager.client(target)

    expect(first).toBe(second)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    children[0]?.ready(43123)

    const [firstClient, secondClient] = await Promise.all([first, second])
    expect(firstClient).toBe(secondClient)
    expect(firstClient.baseUrl).toBe('http://127.0.0.1:43123')
    await manager.close()
  })

  it('clears a failed startup so a later call can retry', async () => {
    const manager = new ServiceRuntimeManager(() => undefined)
    const first = manager.client(target)
    const second = manager.client(target)

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    children[0]?.fail('first startup failed')
    await expect(first).rejects.toThrow('first startup failed')
    await expect(second).rejects.toThrow('first startup failed')

    const retry = manager.client(target)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    children[1]?.ready(43124)
    await expect(retry).resolves.toMatchObject({ baseUrl: 'http://127.0.0.1:43124' })
    await manager.close()
  })
})

describe('Windows paper-fetch command resolution', () => {
  it('uses the official installer Python without executing the cmd shim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'litroot-paper-fetch-'))
    try {
      await mkdir(join(root, 'bin'))
      await mkdir(join(root, 'runtime'))
      await writeFile(join(root, 'bin', 'paper-fetch.cmd'), '@echo off\n')
      await writeFile(join(root, 'runtime', 'python.exe'), '')
      await expect(windowsPaperFetchCommand(join(root, 'bin', 'paper-fetch.cmd'))).resolves.toEqual({
        executable: join(root, 'runtime', 'python.exe'),
        prefixArgs: ['-X', 'utf8', '-m', 'paper_fetch.cli']
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
