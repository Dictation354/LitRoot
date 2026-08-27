import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/tmp/litroot-test'
  }
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnMock }
})

import { WslServiceManager } from '../../src/main/wsl-manager.js'

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

const distribution = process.env.LITROOT_DEV_DISTRIBUTION || 'Local WSL development'
let children: FakeChildProcess[] = []

beforeEach(() => {
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
  vi.unstubAllGlobals()
})

describe('WSL service startup', () => {
  it('shares one in-flight startup per distribution', async () => {
    const manager = new WslServiceManager(() => undefined)
    const first = manager.client(distribution)
    const second = manager.client(distribution)

    expect(first).toBe(second)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    children[0]?.ready(43123)

    const [firstClient, secondClient] = await Promise.all([first, second])
    expect(firstClient).toBe(secondClient)
    expect(firstClient.baseUrl).toBe('http://127.0.0.1:43123')
    await manager.close()
  })

  it('clears a failed startup so a later call can retry', async () => {
    const manager = new WslServiceManager(() => undefined)
    const first = manager.client(distribution)
    const second = manager.client(distribution)

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    children[0]?.fail('first startup failed')
    await expect(first).rejects.toThrow('first startup failed')
    await expect(second).rejects.toThrow('first startup failed')

    const retry = manager.client(distribution)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    children[1]?.ready(43124)
    await expect(retry).resolves.toMatchObject({ baseUrl: 'http://127.0.0.1:43124' })
    await manager.close()
  })
})
