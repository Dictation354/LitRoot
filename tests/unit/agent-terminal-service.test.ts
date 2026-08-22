import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RootSummary } from '../../src/shared/contracts.js'
import { IPC } from '../../src/shared/contracts.js'
import {
  AgentTerminalService,
  MAX_AGENT_TERMINAL_INPUT_BYTES,
  TerminalOutputFilter,
  agentTerminalEnvironment,
  codexExecutableCandidates,
  codexTerminalArguments,
  codexTerminalLaunch,
  resolveCodexExecutable,
  type AgentTerminalOwner,
  type AgentTerminalPty,
  type AgentTerminalPtyArguments,
  type AgentTerminalPtyExitEvent,
  type AgentTerminalPtyModule,
  type AgentTerminalPtySpawnOptions
} from '../../src/main/application/agent-terminal-service.js'
import type { LibraryService } from '../../src/main/application/library-service.js'

interface SpawnRecord {
  executable: string
  args: AgentTerminalPtyArguments
  options: AgentTerminalPtySpawnOptions
  pty: FakePty
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined
  let reject: (reason?: unknown) => void = () => undefined
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

class FakePty implements AgentTerminalPty {
  readonly pid = 4242
  readonly writes: string[] = []
  readonly resizes: Array<[number, number]> = []
  readonly kills: Array<string | undefined> = []
  exitOnKill = true
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: AgentTerminalPtyExitEvent) => void>()

  write(data: string): void {
    this.writes.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }

  kill(signal?: string): void {
    this.kills.push(signal)
    if (this.exitOnKill) this.emitExit(143, 15)
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  onExit(listener: (event: AgentTerminalPtyExitEvent) => void): { dispose(): void } {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }

  emitData(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data)
  }

  emitExit(exitCode: number, signal?: number): void {
    const event: AgentTerminalPtyExitEvent = {
      exitCode,
      ...(signal === undefined ? {} : { signal })
    }
    for (const listener of [...this.exitListeners]) listener(event)
  }
}

class FakeOwner implements AgentTerminalOwner {
  destroyed = false
  readonly messages: Array<{ channel: string; payload: unknown }> = []

  constructor(readonly id: number) {}

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, payload: unknown): void {
    this.messages.push({ channel, payload })
  }
}

function root(id: string, path = `/research/${id}`): RootSummary {
  return {
    id,
    path,
    label: `Project ${id}`,
    status: 'ready',
    error: null,
    paperCount: 1,
    issueCount: 0,
    lastScannedAt: null,
    createdAt: '2026-08-20T00:00:00.000Z'
  }
}

function fixture(
  roots: RootSummary[] = [root('root-one')],
  overrides: {
    canonicalizeRoot?: (path: string) => Promise<string>
    environment?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    resolveCodexExecutable?: () => Promise<string>
    maxOutputCharacters?: number
    maxOutputChunkCharacters?: number
    stopGraceMs?: number
    killGraceMs?: number
  } = {}
): {
  service: AgentTerminalService
  spawns: SpawnRecord[]
} {
  const spawns: SpawnRecord[] = []
  const ptyModule: AgentTerminalPtyModule = {
    spawn: (executable, args, options) => {
      const pty = new FakePty()
      spawns.push({ executable, args, options, pty })
      return pty
    }
  }
  const library = { listRoots: () => roots } as unknown as LibraryService
  const service = new AgentTerminalService(library, {
    loadPty: async () => ptyModule,
    resolveCodexExecutable:
      overrides.resolveCodexExecutable ?? (async () => '/opt/codex/bin/codex'),
    canonicalizeRoot: overrides.canonicalizeRoot ?? (async (path) => path),
    createSessionId: () => `session-${spawns.length + 1}`,
    now: () => new Date('2026-08-20T01:02:03.000Z'),
    environment:
      overrides.environment ??
      {
        HOME: '/Users/researcher',
        PATH: '/opt/codex/bin:/usr/bin',
        OPENAI_API_KEY: 'expected-auth-secret',
        NODE_OPTIONS: '--require=/tmp/untrusted-hook.js',
        PAPERRELAY_DATABASE: '/private/catalog.sqlite3',
        UNRELATED_SECRET: 'not-forwarded'
      },
    platform: overrides.platform ?? 'darwin',
    ...(overrides.maxOutputCharacters === undefined
      ? {}
      : { maxOutputCharacters: overrides.maxOutputCharacters }),
    ...(overrides.maxOutputChunkCharacters === undefined
      ? {}
      : { maxOutputChunkCharacters: overrides.maxOutputChunkCharacters }),
    ...(overrides.stopGraceMs === undefined ? {} : { stopGraceMs: overrides.stopGraceMs }),
    ...(overrides.killGraceMs === undefined ? {} : { killGraceMs: overrides.killGraceMs })
  })
  return { service, spawns }
}

describe('AgentTerminalService launch authority', () => {
  it('launches the fixed Codex executable in read-only mode by default', async () => {
    const { service, spawns } = fixture()
    const owner = new FakeOwner(1)

    const session = await service.start(owner, { rootId: 'root-one', cols: 120, rows: 42 })

    expect(session).toEqual({
      id: 'session-1',
      rootId: 'root-one',
      rootLabel: 'Project root-one',
      cwd: '/research/root-one',
      access: 'read-only',
      state: 'running',
      startedAt: '2026-08-20T01:02:03.000Z'
    })
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({
      executable: '/opt/codex/bin/codex',
      args: [
        '--no-alt-screen',
        '--cd',
        '/research/root-one',
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'never'
      ],
      options: {
        name: 'xterm-256color',
        cols: 120,
        rows: 42,
        cwd: '/research/root-one'
      }
    })
    expect(spawns[0]?.options.env).toMatchObject({
      HOME: '/Users/researcher',
      PATH: '/opt/codex/bin:/usr/bin',
      OPENAI_API_KEY: 'expected-auth-secret',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'PaperRelay'
    })
    expect(spawns[0]?.options.env).not.toHaveProperty('NODE_OPTIONS')
    expect(spawns[0]?.options.env).not.toHaveProperty('PAPERRELAY_DATABASE')
    expect(spawns[0]?.options.env).not.toHaveProperty('UNRELATED_SECRET')
  })

  it('uses workspace-write with on-request approval only after that mode is selected', async () => {
    const { service, spawns } = fixture()

    await service.start(new FakeOwner(2), {
      rootId: 'root-one',
      access: 'workspace-write'
    })

    expect(spawns[0]?.args).toEqual([
      '--no-alt-screen',
      '--cd',
      '/research/root-one',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request'
    ])
    const command = Array.isArray(spawns[0]?.args) ? spawns[0].args.join(' ') : spawns[0]?.args
    expect(command).not.toMatch(/danger|bypass|add-dir/)
  })

  it('wraps a Windows npm command shim with ComSpec and stops it without a signal', async () => {
    const rootPath = String.raw`D:\Research & Notes`
    const commandShim = String.raw`C:\Users\Research User\AppData\Roaming\npm\codex.cmd`
    const commandInterpreter = String.raw`C:\Windows\System32\cmd.exe`
    const { service, spawns } = fixture([root('root-one', rootPath)], {
      environment: {
        ComSpec: commandInterpreter,
        Path: String.raw`C:\Users\Research User\AppData\Roaming\npm;C:\Windows\System32`,
        SystemRoot: String.raw`C:\Windows`,
        USERPROFILE: String.raw`C:\Users\Research User`
      },
      platform: 'win32',
      resolveCodexExecutable: async () => commandShim
    })
    const owner = new FakeOwner(3)

    const session = await service.start(owner, { rootId: 'root-one' })

    expect(spawns[0]?.executable).toBe(commandInterpreter)
    expect(spawns[0]?.args).toBe(
      String.raw`/d /s /v:off /c ""C:\Users\Research User\AppData\Roaming\npm\codex.cmd" "--no-alt-screen" "--cd" "D:\Research & Notes" "--sandbox" "read-only" "--ask-for-approval" "never""`
    )
    expect(spawns[0]?.options.env).toMatchObject({
      ComSpec: commandInterpreter,
      PATH: String.raw`C:\Users\Research User\AppData\Roaming\npm;C:\Windows\System32`,
      SystemRoot: String.raw`C:\Windows`,
      USERPROFILE: String.raw`C:\Users\Research User`
    })

    await service.stop(owner.id, session.id)
    expect(spawns[0]?.pty.kills).toEqual([undefined])
  })

  it('rejects unregistered, moved, duplicate, and closed-window launches', async () => {
    const owner = new FakeOwner(3)
    const { service } = fixture()
    await expect(service.start(owner, { rootId: 'unknown' })).rejects.toThrow(/no longer registered/i)

    const moved = fixture([root('root-one')], {
      canonicalizeRoot: async () => '/research/replaced-target'
    }).service
    await expect(moved.start(new FakeOwner(4), { rootId: 'root-one' })).rejects.toThrow(
      /different location/i
    )

    const first = await service.start(owner, { rootId: 'root-one' })
    await expect(service.start(owner, { rootId: 'root-one' })).rejects.toThrow(/already has/i)
    await service.stop(owner.id, first.id)
    await service.stopOwner(owner.id)
    await expect(service.start(owner, { rootId: 'root-one' })).rejects.toThrow(/closing/i)
  })

  it('reserves an owner before asynchronous terminal loading can race a second start', async () => {
    const { service, spawns } = fixture()
    const owner = new FakeOwner(5)

    const firstStart = service.start(owner, { rootId: 'root-one' })
    await expect(service.start(owner, { rootId: 'root-one' })).rejects.toThrow(/already has/i)
    await firstStart

    expect(spawns).toHaveLength(1)
  })
})

describe('AgentTerminalService session boundary', () => {
  it('enforces owner isolation, 16 KiB input, and clamped resize dimensions', async () => {
    const { service, spawns } = fixture()
    const owner = new FakeOwner(10)
    const session = await service.start(owner, { rootId: 'root-one', cols: 9_999, rows: -20 })
    const pty = spawns[0]!.pty

    expect(spawns[0]?.options).toMatchObject({ cols: 400, rows: 5 })
    service.write(owner.id, session.id, 'a'.repeat(MAX_AGENT_TERMINAL_INPUT_BYTES))
    expect(pty.writes).toEqual(['a'.repeat(MAX_AGENT_TERMINAL_INPUT_BYTES)])
    expect(() => service.write(owner.id, session.id, '🙂'.repeat(4_097))).toThrow(/16[ ,]?384 bytes/i)
    expect(() => service.write(999, session.id, 'x')).toThrow(/this window/i)

    service.resize(owner.id, session.id, 8_000, 1)
    expect(pty.resizes).toEqual([[400, 5]])
  })

  it('emits no transcript, strips split OSC 52 output, and bounds event chunks', async () => {
    const { service, spawns } = fixture([root('root-one')], {
      maxOutputCharacters: 100,
      maxOutputChunkCharacters: 2
    })
    const owner = new FakeOwner(11)
    const session = await service.start(owner, { rootId: 'root-one' })
    const pty = spawns[0]!.pty

    pty.emitData('ab\u001b]5')
    pty.emitData('2;c;clipboard secret\u001b\\cdef')

    const output = owner.messages
      .filter((message) => message.channel === IPC.agentTerminalOutput)
      .map((message) => (message.payload as { data: string }).data)
    expect(output).toEqual(['ab', 'cd', 'ef'])
    expect(output.join('')).not.toContain('clipboard secret')
    expect(output.every((chunk) => chunk.length <= 2)).toBe(true)
    expect(session).not.toHaveProperty('transcript')
  })

  it('stops runaway output at a fixed session limit', async () => {
    const { service, spawns } = fixture([root('root-one')], {
      maxOutputCharacters: 10,
      maxOutputChunkCharacters: 4
    })
    const owner = new FakeOwner(12)
    await service.start(owner, { rootId: 'root-one' })
    const pty = spawns[0]!.pty

    pty.emitData('abcdefghijklmnop')

    expect(pty.kills).toEqual(['SIGTERM'])
    const output = owner.messages
      .filter((message) => message.channel === IPC.agentTerminalOutput)
      .map((message) => (message.payload as { data: string }).data)
    expect(output.slice(0, 3)).toEqual(['abcd', 'efgh', 'ij'])
    expect(output.at(-1)).toContain('terminal output limit')
    expect(owner.messages.at(-1)).toMatchObject({
      channel: IPC.agentTerminalExit,
      payload: { reason: 'error' }
    })
  })

  it('stops sessions before their root, owner, or application is closed', async () => {
    const roots = [root('one'), root('two')]
    const { service, spawns } = fixture(roots)
    const firstOwner = new FakeOwner(20)
    const secondOwner = new FakeOwner(21)
    const first = await service.start(firstOwner, { rootId: 'one' })
    await service.start(secondOwner, { rootId: 'two' })

    await service.stopRoot('one')
    expect(spawns[0]?.pty.kills).toEqual(['SIGTERM'])
    expect(spawns[1]?.pty.kills).toEqual([])
    await expect(service.stop(firstOwner.id, first.id)).rejects.toThrow(/no longer available/i)

    await service.close()
    expect(spawns[1]?.pty.kills).toEqual(['SIGTERM'])
    expect(secondOwner.messages.at(-1)).toMatchObject({
      channel: IPC.agentTerminalExit,
      payload: { reason: 'stopped' }
    })
  })

  it('cancels and settles an in-flight start before a root is removed', async () => {
    const canonicalRoot = deferred<string>()
    const canonicalizeEntered = deferred<void>()
    const { service, spawns } = fixture([root('root-one')], {
      canonicalizeRoot: (path) => {
        canonicalizeEntered.resolve()
        return canonicalRoot.promise.then(() => path)
      }
    })
    const owner = new FakeOwner(23)
    const starting = service.start(owner, { rootId: 'root-one' })
    const cancelledStart = expect(starting).rejects.toThrow(/being disconnected/i)
    await canonicalizeEntered.promise

    await service.stopRoot('root-one')

    await cancelledStart
    expect(service.isOwnerBusy(owner.id)).toBe(false)
    expect(spawns).toHaveLength(0)
    await expect(
      service.start(new FakeOwner(24), { rootId: 'root-one' })
    ).rejects.toThrow(/being disconnected/i)

    canonicalRoot.resolve('/research/root-one')
    await Promise.resolve()
    expect(spawns).toHaveLength(0)

    service.releaseRootStop('root-one')
    const replacementOwner = new FakeOwner(25)
    const replacement = await service.start(replacementOwner, { rootId: 'root-one' })
    expect(spawns).toHaveLength(1)
    await service.stop(replacementOwner.id, replacement.id)
  })

  it('settles in-flight starts before an owner or the application closes', async () => {
    const ownerGate = deferred<string>()
    const ownerEntered = deferred<void>()
    const ownerFixture = fixture([root('root-one')], {
      canonicalizeRoot: () => {
        ownerEntered.resolve()
        return ownerGate.promise
      }
    })
    const owner = new FakeOwner(26)
    const ownerStart = ownerFixture.service.start(owner, { rootId: 'root-one' })
    const ownerCancelled = expect(ownerStart).rejects.toThrow(/window is closing/i)
    await ownerEntered.promise

    await ownerFixture.service.stopOwner(owner.id)

    await ownerCancelled
    expect(ownerFixture.service.isOwnerBusy(owner.id)).toBe(false)
    expect(ownerFixture.spawns).toHaveLength(0)

    const closeGate = deferred<string>()
    const closeEntered = deferred<void>()
    const closeFixture = fixture([root('root-one')], {
      canonicalizeRoot: () => {
        closeEntered.resolve()
        return closeGate.promise
      }
    })
    const closingOwner = new FakeOwner(27)
    const closeStart = closeFixture.service.start(closingOwner, { rootId: 'root-one' })
    const closeCancelled = expect(closeStart).rejects.toThrow(/window is closing/i)
    await closeEntered.promise

    await closeFixture.service.close()

    await closeCancelled
    expect(closeFixture.service.isOwnerBusy(closingOwner.id)).toBe(false)
    expect(closeFixture.spawns).toHaveLength(0)
  })

  it('settles pending and live sessions across a reload, then permits the new renderer', async () => {
    const canonicalRoot = deferred<string>()
    const canonicalizeEntered = deferred<void>()
    const { service, spawns } = fixture([root('root-one')], {
      canonicalizeRoot: (path) => {
        canonicalizeEntered.resolve()
        return canonicalRoot.promise.then(() => path)
      }
    })
    const owner = new FakeOwner(28)
    const starting = service.start(owner, { rootId: 'root-one' })
    const cancelledStart = expect(starting).rejects.toThrow(/view is reloading/i)
    await canonicalizeEntered.promise

    await service.beginOwnerReload(owner.id)

    await cancelledStart
    expect(spawns).toHaveLength(0)
    await expect(service.start(owner, { rootId: 'root-one' })).rejects.toThrow(/view is reloading/i)

    service.finishOwnerReload(owner.id)
    canonicalRoot.resolve('/research/root-one')
    const live = await service.start(owner, { rootId: 'root-one' })
    expect(spawns).toHaveLength(1)

    await service.beginOwnerReload(owner.id)

    expect(spawns[0]?.pty.kills).toEqual(['SIGTERM'])
    await expect(service.stop(owner.id, live.id)).rejects.toThrow(/no longer available/i)
    await expect(service.start(owner, { rootId: 'root-one' })).rejects.toThrow(/view is reloading/i)

    service.finishOwnerReload(owner.id)
    const replacement = await service.start(owner, { rootId: 'root-one' })
    expect(spawns).toHaveLength(2)
    await service.stop(owner.id, replacement.id)
  })

  it('keeps the reload gate until a slow PTY stop settles after the renderer loads', async () => {
    const { service, spawns } = fixture([root('root-one')], {
      stopGraceMs: 1,
      killGraceMs: 1
    })
    const owner = new FakeOwner(29)
    await service.start(owner, { rootId: 'root-one' })
    const pty = spawns[0]!.pty
    pty.exitOnKill = false

    const cleanup = service.beginOwnerReload(owner.id)
    service.finishOwnerReload(owner.id)

    await expect(service.start(owner, { rootId: 'root-one' })).rejects.toThrow(/view is reloading/i)
    await cleanup
    expect(pty.kills).toEqual(['SIGTERM', 'SIGKILL'])

    const replacement = await service.start(owner, { rootId: 'root-one' })
    expect(spawns).toHaveLength(2)
    await service.stop(owner.id, replacement.id)
  })

  it('force-cleans a PTY that does not acknowledge termination', async () => {
    const { service, spawns } = fixture([root('root-one')], {
      stopGraceMs: 1,
      killGraceMs: 1
    })
    const owner = new FakeOwner(22)
    const session = await service.start(owner, { rootId: 'root-one' })
    const pty = spawns[0]!.pty
    pty.exitOnKill = false

    await service.stop(owner.id, session.id)

    expect(pty.kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(owner.messages.at(-1)).toMatchObject({
      channel: IPC.agentTerminalExit,
      payload: { sessionId: session.id, reason: 'stopped', exitCode: null, signal: null }
    })
  })

  it('uses signal-less Windows termination for both stop attempts', async () => {
    const { service, spawns } = fixture([root('root-one')], {
      killGraceMs: 1,
      platform: 'win32',
      stopGraceMs: 1
    })
    const owner = new FakeOwner(30)
    const session = await service.start(owner, { rootId: 'root-one' })
    const pty = spawns[0]!.pty
    pty.exitOnKill = false

    await service.stop(owner.id, session.id)

    expect(pty.kills).toEqual([undefined, undefined])
  })
})

describe('terminal safety helpers', () => {
  it('strips BEL, ST, C1, and chunk-split OSC 52 sequences while preserving other OSC output', () => {
    const filter = new TerminalOutputFilter()
    const parts = [
      filter.write('before\u001b]52;c;secret\u0007after\u001b]0;window title\u0007'),
      filter.write('x\u001b]5'),
      filter.write('2;c;other secret\u001b'),
      filter.write('\\y\u009d052;c;c1 secret\u009cz')
    ]

    expect(parts.join('')).toBe('beforeafter\u001b]0;window title\u0007xyz')
  })

  it('bounds an unterminated OSC 52 sequence made only of escape bytes', () => {
    const filter = new TerminalOutputFilter()

    const warning = filter.write(`\u001b]52;${'\u001b'.repeat(1024 * 1024 + 1)}`)

    expect(warning).toContain('removed an unterminated terminal clipboard sequence')
    expect(filter.write('after')).toBe('after')
  })

  it('constructs exact approval arguments and a fixed environment allowlist', () => {
    expect(codexTerminalArguments('read-only', '/project')).toEqual([
      '--no-alt-screen',
      '--cd',
      '/project',
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never'
    ])
    expect(codexTerminalArguments('workspace-write', '/project')).toEqual([
      '--no-alt-screen',
      '--cd',
      '/project',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request'
    ])
    expect(
      agentTerminalEnvironment({
        HOME: '/home/user',
        LC_ALL: 'en_US.UTF-8',
        NODE_OPTIONS: '--require evil',
        RANDOM_VALUE: 'blocked'
      })
    ).toEqual({
      HOME: '/home/user',
      LC_ALL: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'PaperRelay'
    })
  })

  it('normalizes the allowlisted Windows environment without forwarding unsafe variables', () => {
    expect(
      agentTerminalEnvironment(
        {
          APPDATA: String.raw`C:\Users\Researcher\AppData\Roaming`,
          ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
          LocalAppData: String.raw`C:\Users\Researcher\AppData\Local`,
          NODE_OPTIONS: '--require evil',
          openai_api_key: 'expected-auth-secret',
          Path: String.raw`C:\Tools;C:\Windows\System32`,
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
          SystemRoot: String.raw`C:\Windows`,
          userprofile: String.raw`C:\Users\Researcher`,
          UNRELATED_SECRET: 'blocked'
        },
        'win32'
      )
    ).toEqual({
      APPDATA: String.raw`C:\Users\Researcher\AppData\Roaming`,
      ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
      LOCALAPPDATA: String.raw`C:\Users\Researcher\AppData\Local`,
      OPENAI_API_KEY: 'expected-auth-secret',
      PATH: String.raw`C:\Tools;C:\Windows\System32`,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      SystemRoot: String.raw`C:\Windows`,
      USERPROFILE: String.raw`C:\Users\Researcher`,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'PaperRelay'
    })
  })

  it('splits Windows Path values with win32 semantics on every host', () => {
    expect(
      codexExecutableCandidates(
        { Path: String.raw`C:\Users\Researcher\bin;relative;D:\Codex Tools` },
        'win32'
      )
    ).toEqual([
      String.raw`C:\Users\Researcher\bin\codex.exe`,
      String.raw`C:\Users\Researcher\bin\codex.cmd`,
      String.raw`C:\Users\Researcher\bin\codex`,
      String.raw`D:\Codex Tools\codex.exe`,
      String.raw`D:\Codex Tools\codex.cmd`,
      String.raw`D:\Codex Tools\codex`
    ])
  })

  it('keeps native Windows executables direct and requires an absolute cmd interpreter for shims', () => {
    expect(
      codexTerminalLaunch(
        String.raw`C:\Tools\codex.exe`,
        'read-only',
        String.raw`D:\Research`,
        {},
        'win32'
      )
    ).toEqual({
      executable: String.raw`C:\Tools\codex.exe`,
      args: [
        '--no-alt-screen',
        '--cd',
        String.raw`D:\Research`,
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'never'
      ]
    })
    expect(() =>
      codexTerminalLaunch(
        String.raw`C:\Tools\codex.cmd`,
        'read-only',
        String.raw`D:\Research`,
        { ComSpec: 'cmd.exe' },
        'win32'
      )
    ).toThrow(/command interpreter/i)
  })

  it.skipIf(!existsSync('/opt/homebrew/bin/codex'))(
    'resolves the installed Codex executable through its fixed command name',
    async () => {
      const executable = await resolveCodexExecutable(
        { PATH: '/opt/homebrew/bin:/usr/bin' },
        'darwin'
      )

      expect(executable).toMatch(/\/codex$/)
    }
  )
})
