import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access as accessFile, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { posix, win32 } from 'node:path'
import type {
  AgentTerminalAccess,
  AgentTerminalExit,
  AgentTerminalExitReason,
  AgentTerminalOutput,
  AgentTerminalSession,
  AgentTerminalStartRequest,
  RootSummary
} from '../../shared/contracts.js'
import { IPC } from '../../shared/contracts.js'
import { validateRootPath } from '../ingest/walk.js'
import type { LibraryService } from './library-service.js'

export const MAX_AGENT_TERMINAL_INPUT_BYTES = 16 * 1024
export const MAX_AGENT_TERMINAL_OUTPUT_CHARACTERS = 32 * 1024 * 1024
export const MAX_AGENT_TERMINAL_OUTPUT_CHUNK_CHARACTERS = 64 * 1024
export const MIN_AGENT_TERMINAL_COLUMNS = 20
export const MAX_AGENT_TERMINAL_COLUMNS = 400
export const MIN_AGENT_TERMINAL_ROWS = 5
export const MAX_AGENT_TERMINAL_ROWS = 200
export const DEFAULT_AGENT_TERMINAL_COLUMNS = 100
export const DEFAULT_AGENT_TERMINAL_ROWS = 30

const MAX_OSC_CODE_CHARACTERS = 16
const MAX_STRIPPED_OSC_CHARACTERS = 1024 * 1024
const DEFAULT_STOP_GRACE_MS = 750
const DEFAULT_KILL_GRACE_MS = 500
const nodeRequire = createRequire(import.meta.url)

interface Disposable {
  dispose(): void
}

export interface AgentTerminalPtyExitEvent {
  exitCode: number
  signal?: number
}

export interface AgentTerminalPty {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): Disposable
  onExit(listener: (event: AgentTerminalPtyExitEvent) => void): Disposable
}

export interface AgentTerminalPtySpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}

export type AgentTerminalPtyArguments = string[] | string

export interface AgentTerminalPtyModule {
  spawn(
    executable: string,
    args: AgentTerminalPtyArguments,
    options: AgentTerminalPtySpawnOptions
  ): AgentTerminalPty
}

export interface AgentTerminalOwner {
  readonly id: number
  isDestroyed(): boolean
  send(channel: string, payload: AgentTerminalOutput | AgentTerminalExit): void
}

export type AgentTerminalPtyLoader = () => Promise<AgentTerminalPtyModule>
export type CodexExecutableResolver = () => Promise<string>

export interface AgentTerminalServiceOptions {
  loadPty?: AgentTerminalPtyLoader
  resolveCodexExecutable?: CodexExecutableResolver
  canonicalizeRoot?: (path: string) => Promise<string>
  createSessionId?: () => string
  now?: () => Date
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  maxOutputCharacters?: number
  maxOutputChunkCharacters?: number
  stopGraceMs?: number
  killGraceMs?: number
}

interface RunningSession {
  publicSession: AgentTerminalSession
  owner: AgentTerminalOwner
  pty: AgentTerminalPty
  filter: TerminalOutputFilter
  cols: number
  rows: number
  outputCharacters: number
  finalized: boolean
  requestedExitReason: AgentTerminalExitReason | null
  dataDisposable: Disposable | null
  exitDisposable: Disposable | null
  terminateTimer: ReturnType<typeof setTimeout> | null
  killTimer: ReturnType<typeof setTimeout> | null
  stopPromise: Promise<void> | null
  resolveStop: (() => void) | null
}

interface StartingSession {
  ownerId: number
  rootId: string
  cancelled: boolean
  cancellation: Promise<void>
  resolveCancellation: () => void
  settled: Promise<void>
  resolveSettled: () => void
}

interface ReloadingOwner {
  generation: number
  loaded: boolean
  settled: boolean
  cleanup: Promise<void>
}

type FilterState = 'text' | 'escape' | 'osc-code' | 'osc-code-escape' | 'strip' | 'strip-escape'

/**
 * Removes OSC 52 clipboard control sequences before terminal output reaches the
 * renderer. The parser is streaming so split PTY chunks cannot bypass it.
 */
export class TerminalOutputFilter {
  private state: FilterState = 'text'
  private oscIntroducer = ''
  private oscCode = ''
  private strippedCharacters = 0

  write(chunk: string): string {
    let output = ''

    const reset = (): void => {
      this.state = 'text'
      this.oscIntroducer = ''
      this.oscCode = ''
      this.strippedCharacters = 0
    }

    const startOsc = (introducer: string): void => {
      this.state = 'osc-code'
      this.oscIntroducer = introducer
      this.oscCode = ''
    }

    const stripCharacter = (): boolean => {
      this.strippedCharacters += 1
      if (this.strippedCharacters <= MAX_STRIPPED_OSC_CHARACTERS) return true
      output += '\r\n[PaperRelay removed an unterminated terminal clipboard sequence.]\r\n'
      reset()
      return false
    }

    const processTextCharacter = (character: string): void => {
      if (character === '\u001b') {
        this.state = 'escape'
      } else if (character === '\u009d') {
        startOsc(character)
      } else {
        output += character
      }
    }

    for (const character of chunk) {
      switch (this.state) {
        case 'text':
          processTextCharacter(character)
          break
        case 'escape':
          if (character === ']') {
            startOsc('\u001b]')
          } else {
            output += '\u001b'
            this.state = 'text'
            processTextCharacter(character)
          }
          break
        case 'osc-code':
          if (character === ';') {
            if (isClipboardOscCode(this.oscCode)) {
              this.state = 'strip'
              this.strippedCharacters = 0
            } else {
              output += `${this.oscIntroducer}${this.oscCode};`
              reset()
            }
          } else if (character === '\u0007' || character === '\u009c') {
            if (!isClipboardOscCode(this.oscCode)) {
              output += `${this.oscIntroducer}${this.oscCode}${character}`
            }
            reset()
          } else if (character === '\u001b') {
            this.state = 'osc-code-escape'
          } else {
            this.oscCode += character
            if (this.oscCode.length > MAX_OSC_CODE_CHARACTERS) {
              output += `${this.oscIntroducer}${this.oscCode}`
              reset()
            }
          }
          break
        case 'osc-code-escape':
          if (character === '\\') {
            if (!isClipboardOscCode(this.oscCode)) {
              output += `${this.oscIntroducer}${this.oscCode}\u001b\\`
            }
            reset()
          } else if (isClipboardOscCode(this.oscCode)) {
            this.state = 'strip'
            stripCharacter()
          } else {
            output += `${this.oscIntroducer}${this.oscCode}\u001b`
            reset()
            processTextCharacter(character)
          }
          break
        case 'strip':
          if (character === '\u0007' || character === '\u009c') {
            reset()
          } else if (character === '\u001b') {
            if (stripCharacter()) this.state = 'strip-escape'
          } else {
            stripCharacter()
          }
          break
        case 'strip-escape':
          if (character === '\\' || character === '\u0007' || character === '\u009c') {
            reset()
          } else if (stripCharacter()) {
            this.state = character === '\u001b' ? 'strip-escape' : 'strip'
          }
          break
      }
    }

    return output
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback
}

export function clampAgentTerminalColumns(value: number | undefined): number {
  const normalized = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : DEFAULT_AGENT_TERMINAL_COLUMNS
  return Math.min(
    MAX_AGENT_TERMINAL_COLUMNS,
    Math.max(MIN_AGENT_TERMINAL_COLUMNS, normalized)
  )
}

export function clampAgentTerminalRows(value: number | undefined): number {
  const normalized = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : DEFAULT_AGENT_TERMINAL_ROWS
  return Math.min(
    MAX_AGENT_TERMINAL_ROWS,
    Math.max(MIN_AGENT_TERMINAL_ROWS, normalized)
  )
}

export function codexTerminalArguments(accessMode: AgentTerminalAccess, cwd: string): string[] {
  return [
    '--no-alt-screen',
    '--cd',
    cwd,
    '--sandbox',
    accessMode,
    '--ask-for-approval',
    accessMode === 'read-only' ? 'never' : 'on-request'
  ]
}

const TERMINAL_ENVIRONMENT_KEYS = new Set([
  'ALL_PROXY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_API_KEY',
  'CODEX_HOME',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LOGNAME',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'PATH',
  'SHELL',
  'SSH_AUTH_SOCK',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy'
])

const WINDOWS_TERMINAL_ENVIRONMENT_KEYS = new Set([
  ...Array.from(TERMINAL_ENVIRONMENT_KEYS, (key) => key.toUpperCase()),
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PATHEXT',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR'
])

const WINDOWS_ENVIRONMENT_KEY_NAMES = new Map([
  ['COMSPEC', 'ComSpec'],
  ['SYSTEMROOT', 'SystemRoot']
])

function terminalEnvironmentKey(key: string, platform: NodeJS.Platform): string | null {
  if (platform !== 'win32') {
    return TERMINAL_ENVIRONMENT_KEYS.has(key) || key.startsWith('LC_') ? key : null
  }
  const normalized = key.toUpperCase()
  if (!WINDOWS_TERMINAL_ENVIRONMENT_KEYS.has(normalized) && !normalized.startsWith('LC_')) {
    return null
  }
  return WINDOWS_ENVIRONMENT_KEY_NAMES.get(normalized) ?? normalized
}

function environmentValue(
  environment: NodeJS.ProcessEnv | Record<string, string>,
  key: string,
  platform: NodeJS.Platform
): string | undefined {
  const direct = environment[key]
  if (direct !== undefined || platform !== 'win32') return direct
  const normalized = key.toUpperCase()
  return Object.entries(environment).find(
    ([candidate, value]) => value !== undefined && candidate.toUpperCase() === normalized
  )?.[1]
}

export function agentTerminalEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue
    const acceptedKey = terminalEnvironmentKey(key, platform)
    if (acceptedKey) result[acceptedKey] = value
  }
  result.TERM = 'xterm-256color'
  result.COLORTERM = 'truecolor'
  result.TERM_PROGRAM = 'PaperRelay'
  return result
}

function pathForPlatform(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === 'win32' ? win32 : posix
}

function codexExecutableNames(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex']
}

export function codexExecutableCandidates(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string[] {
  const path = pathForPlatform(platform)
  const executableNames = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex']
  const candidates: string[] = []
  for (const directory of (environmentValue(environment, 'PATH', platform) ?? '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue
    for (const executable of executableNames) candidates.push(path.join(directory, executable))
  }
  if (platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/codex', '/usr/local/bin/codex')
  } else if (platform !== 'win32') {
    candidates.push('/usr/local/bin/codex', '/usr/bin/codex')
  }
  return [...new Set(candidates)]
}

export interface CodexTerminalLaunch {
  executable: string
  args: AgentTerminalPtyArguments
}

function windowsCommandInterpreter(environment: Record<string, string>): string {
  const configured = environmentValue(environment, 'ComSpec', 'win32')?.trim()
  const systemRoot = environmentValue(environment, 'SystemRoot', 'win32')?.trim()
  const executable = configured || (systemRoot ? win32.join(systemRoot, 'System32', 'cmd.exe') : '')
  if (!win32.isAbsolute(executable) || win32.basename(executable).toLowerCase() !== 'cmd.exe') {
    throw new Error('The Windows command interpreter could not be found in the terminal environment.')
  }
  return executable
}

function windowsCommandArgument(value: string): string {
  if (value.includes('"')) throw new Error('The Codex command contains an invalid quote.')
  return `"${value}"`
}

export function codexTerminalLaunch(
  executable: string,
  accessMode: AgentTerminalAccess,
  cwd: string,
  environment: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): CodexTerminalLaunch {
  const args = codexTerminalArguments(accessMode, cwd)
  const extension = pathForPlatform(platform).extname(executable).toLowerCase()
  if (platform !== 'win32' || (extension !== '.cmd' && extension !== '.bat')) {
    return { executable, args }
  }
  const command = [executable, ...args].map(windowsCommandArgument).join(' ')
  return {
    executable: windowsCommandInterpreter(environment),
    args: `/d /s /v:off /c "${command}"`
  }
}

function isClipboardOscCode(value: string): boolean {
  return /^0*52$/.test(value)
}

export async function resolveCodexExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  const path = pathForPlatform(platform)
  for (const candidate of codexExecutableCandidates(environment, platform)) {
    try {
      const canonical = await realpath(candidate)
      const info = await stat(canonical)
      if (!info.isFile()) continue
      await accessFile(canonical, platform === 'win32' ? constants.F_OK : constants.X_OK)
      if (!codexExecutableNames(platform).includes(path.basename(canonical).toLowerCase())) continue
      return canonical
    } catch {
      // Continue through fixed PATH-derived candidates.
    }
  }
  throw new Error('Codex CLI was not found. Install Codex and make the codex executable available in PATH.')
}

async function loadNodePty(): Promise<AgentTerminalPtyModule> {
  try {
    return nodeRequire('node-pty') as AgentTerminalPtyModule
  } catch (error) {
    throw new Error('The embedded terminal runtime is unavailable. Reinstall PaperRelay and try again.', {
      cause: error
    })
  }
}

function terminalRoot(library: LibraryService, rootId: string): RootSummary {
  const root = library.listRoots().find((candidate) => candidate.id === rootId)
  if (!root) throw new Error('This research folder is no longer registered.')
  return root
}

function requiredAccess(value: AgentTerminalAccess | undefined): AgentTerminalAccess {
  if (value === undefined) return 'read-only'
  if (value === 'read-only' || value === 'workspace-write') return value
  throw new Error('Terminal access mode is invalid.')
}

function requiredRootId(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Research folder is required.')
  const rootId = value.trim()
  if (rootId.length > 200) throw new Error('Research folder identifier is too long.')
  return rootId
}

function requiredSessionId(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new Error('Terminal session is invalid.')
  }
  return value.trim()
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
}

function killAgentTerminalPty(
  pty: AgentTerminalPty,
  signal: 'SIGKILL' | 'SIGTERM',
  platform: NodeJS.Platform
): void {
  if (platform === 'win32') {
    pty.kill()
  } else {
    pty.kill(signal)
  }
}

export class AgentTerminalService {
  private readonly loadPty: AgentTerminalPtyLoader
  private readonly resolveExecutable: CodexExecutableResolver
  private readonly canonicalizeRoot: (path: string) => Promise<string>
  private readonly createSessionId: () => string
  private readonly now: () => Date
  private readonly environment: Record<string, string>
  private readonly platform: NodeJS.Platform
  private readonly maxOutputCharacters: number
  private readonly maxOutputChunkCharacters: number
  private readonly stopGraceMs: number
  private readonly killGraceMs: number
  private readonly sessionsById = new Map<string, RunningSession>()
  private readonly sessionsByOwner = new Map<number, RunningSession>()
  private readonly startsByOwner = new Map<number, StartingSession>()
  private readonly startsByRoot = new Map<string, Set<StartingSession>>()
  private readonly stoppedRootCounts = new Map<string, number>()
  private readonly closedOwners = new Set<number>()
  private readonly reloadingOwners = new Map<number, ReloadingOwner>()
  private closing = false
  private closePromise: Promise<void> | null = null

  constructor(
    private readonly library: LibraryService,
    options: AgentTerminalServiceOptions = {}
  ) {
    const sourceEnvironment = options.environment ?? process.env
    this.platform = options.platform ?? process.platform
    this.loadPty = options.loadPty ?? loadNodePty
    this.resolveExecutable =
      options.resolveCodexExecutable ??
      (() => resolveCodexExecutable(sourceEnvironment, this.platform))
    this.canonicalizeRoot = options.canonicalizeRoot ?? validateRootPath
    this.createSessionId = options.createSessionId ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.environment = agentTerminalEnvironment(sourceEnvironment, this.platform)
    this.maxOutputCharacters = positiveInteger(
      options.maxOutputCharacters,
      MAX_AGENT_TERMINAL_OUTPUT_CHARACTERS
    )
    this.maxOutputChunkCharacters = positiveInteger(
      options.maxOutputChunkCharacters,
      MAX_AGENT_TERMINAL_OUTPUT_CHUNK_CHARACTERS
    )
    this.stopGraceMs = positiveInteger(options.stopGraceMs, DEFAULT_STOP_GRACE_MS)
    this.killGraceMs = positiveInteger(options.killGraceMs, DEFAULT_KILL_GRACE_MS)
  }

  isOwnerBusy(ownerId: number): boolean {
    return (
      this.reloadingOwners.has(ownerId) ||
      this.startsByOwner.has(ownerId) ||
      this.sessionsByOwner.has(ownerId)
    )
  }

  async start(
    owner: AgentTerminalOwner,
    request: AgentTerminalStartRequest
  ): Promise<AgentTerminalSession> {
    if (this.closing || this.closedOwners.has(owner.id) || owner.isDestroyed()) {
      throw new Error('The PaperRelay window is closing.')
    }
    if (this.reloadingOwners.has(owner.id)) throw new Error('The PaperRelay view is reloading.')
    if (this.isOwnerBusy(owner.id)) throw new Error('This window already has an active agent session.')

    const rootId = requiredRootId(request.rootId)
    const accessMode = requiredAccess(request.access)
    const cols = clampAgentTerminalColumns(request.cols)
    const rows = clampAgentTerminalRows(request.rows)
    if (this.isRootStopped(rootId)) {
      throw new Error('This research folder is being disconnected.')
    }
    const starting = this.registerStart(owner.id, rootId)

    try {
      const root = terminalRoot(this.library, rootId)
      const canonicalRoot = await this.waitForStart(
        starting,
        owner,
        this.canonicalizeRoot(root.path)
      )
      if (canonicalRoot !== root.path) {
        throw new Error('The registered research folder now resolves to a different location.')
      }

      const [executable, ptyModule] = await this.waitForStart(
        starting,
        owner,
        Promise.all([this.resolveExecutable(), this.loadPty()])
      )

      this.assertStartAllowed(starting, owner)
      const currentRoot = terminalRoot(this.library, rootId)
      if (currentRoot.path !== root.path) {
        throw new Error('The registered research folder changed before the agent could start.')
      }
      this.assertStartAllowed(starting, owner)

      const publicSession: AgentTerminalSession = {
        id: this.createSessionId(),
        rootId,
        rootLabel: root.label,
        cwd: canonicalRoot,
        access: accessMode,
        state: 'running',
        startedAt: this.now().toISOString()
      }
      const launch = codexTerminalLaunch(
        executable,
        accessMode,
        canonicalRoot,
        this.environment,
        this.platform
      )
      const pty = ptyModule.spawn(launch.executable, launch.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: canonicalRoot,
        env: { ...this.environment }
      })
      const running: RunningSession = {
        publicSession,
        owner,
        pty,
        filter: new TerminalOutputFilter(),
        cols,
        rows,
        outputCharacters: 0,
        finalized: false,
        requestedExitReason: null,
        dataDisposable: null,
        exitDisposable: null,
        terminateTimer: null,
        killTimer: null,
        stopPromise: null,
        resolveStop: null
      }

      this.sessionsById.set(publicSession.id, running)
      this.sessionsByOwner.set(owner.id, running)
      try {
        running.dataDisposable = pty.onData((data) => this.handleOutput(running, data))
        running.exitDisposable = pty.onExit((event) => {
          this.finalizeSession(
            running,
            Number.isFinite(event.exitCode) ? event.exitCode : null,
            typeof event.signal === 'number' && Number.isFinite(event.signal) ? event.signal : null,
            running.requestedExitReason ?? 'exited'
          )
        })
      } catch (error) {
        this.sessionsById.delete(publicSession.id)
        this.sessionsByOwner.delete(owner.id)
        try {
          killAgentTerminalPty(pty, 'SIGKILL', this.platform)
        } catch {
          // The failed PTY may already have exited.
        }
        throw error
      }

      return publicSession
    } finally {
      this.finishStart(starting)
    }
  }

  write(ownerId: number, sessionIdValue: string, data: string): void {
    const session = this.requireOwnedSession(ownerId, sessionIdValue)
    if (session.requestedExitReason) throw new Error('This agent session is stopping.')
    if (typeof data !== 'string') throw new Error('Terminal input must be text.')
    if (Buffer.byteLength(data, 'utf8') > MAX_AGENT_TERMINAL_INPUT_BYTES) {
      throw new Error(`Terminal input is limited to ${MAX_AGENT_TERMINAL_INPUT_BYTES} bytes at a time.`)
    }
    if (data) session.pty.write(data)
  }

  resize(ownerId: number, sessionIdValue: string, colsValue: number, rowsValue: number): void {
    const session = this.requireOwnedSession(ownerId, sessionIdValue)
    if (session.requestedExitReason) return
    const cols = clampAgentTerminalColumns(
      typeof colsValue === 'number' && Number.isFinite(colsValue) ? colsValue : session.cols
    )
    const rows = clampAgentTerminalRows(
      typeof rowsValue === 'number' && Number.isFinite(rowsValue) ? rowsValue : session.rows
    )
    session.cols = cols
    session.rows = rows
    session.pty.resize(cols, rows)
  }

  async stop(ownerId: number, sessionIdValue: string): Promise<void> {
    await this.stopSession(this.requireOwnedSession(ownerId, sessionIdValue), 'stopped')
  }

  async stopOwner(ownerId: number): Promise<void> {
    this.closedOwners.add(ownerId)
    try {
      await this.stopOwnerSessions(ownerId)
    } finally {
      this.reloadingOwners.delete(ownerId)
    }
  }

  beginOwnerReload(ownerId: number): Promise<void> {
    const previous = this.reloadingOwners.get(ownerId)
    const cleanup = this.stopOwnerSessions(ownerId)
    const reloading: ReloadingOwner = {
      generation: (previous?.generation ?? 0) + 1,
      loaded: false,
      settled: false,
      cleanup
    }
    this.reloadingOwners.set(ownerId, reloading)
    void cleanup.then(
      () => this.settleOwnerReload(ownerId, reloading),
      () => this.settleOwnerReload(ownerId, reloading)
    )
    return cleanup
  }

  finishOwnerReload(ownerId: number): void {
    const reloading = this.reloadingOwners.get(ownerId)
    if (!reloading) return
    reloading.loaded = true
    this.releaseOwnerReload(ownerId, reloading)
  }

  private settleOwnerReload(ownerId: number, reloading: ReloadingOwner): void {
    reloading.settled = true
    this.releaseOwnerReload(ownerId, reloading)
  }

  private releaseOwnerReload(ownerId: number, reloading: ReloadingOwner): void {
    const current = this.reloadingOwners.get(ownerId)
    if (
      current?.generation === reloading.generation &&
      reloading.loaded &&
      reloading.settled
    ) {
      this.reloadingOwners.delete(ownerId)
    }
  }

  private async stopOwnerSessions(ownerId: number): Promise<void> {
    const starting = this.startsByOwner.get(ownerId)
    if (starting) {
      this.cancelStart(starting)
      await starting.settled
    }
    const session = this.sessionsByOwner.get(ownerId)
    if (session) await this.stopSession(session, 'stopped')
  }

  async stopRoot(rootIdValue: string): Promise<void> {
    const rootId = requiredRootId(rootIdValue)
    this.stoppedRootCounts.set(rootId, (this.stoppedRootCounts.get(rootId) ?? 0) + 1)
    const starting = [...(this.startsByRoot.get(rootId) ?? [])]
    for (const pending of starting) this.cancelStart(pending)
    await Promise.all(starting.map((pending) => pending.settled))
    const sessions = [...this.sessionsById.values()].filter(
      (session) => session.publicSession.rootId === rootId
    )
    await Promise.all(sessions.map((session) => this.stopSession(session, 'stopped')))
  }

  releaseRootStop(rootIdValue: string): void {
    const rootId = requiredRootId(rootIdValue)
    const count = this.stoppedRootCounts.get(rootId) ?? 0
    if (count <= 1) {
      this.stoppedRootCounts.delete(rootId)
    } else {
      this.stoppedRootCounts.set(rootId, count - 1)
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    const starting = [...this.startsByOwner.values()]
    for (const pending of starting) this.cancelStart(pending)
    this.closePromise = (async () => {
      await Promise.all(starting.map((pending) => pending.settled))
      await Promise.all(
        [...this.sessionsById.values()].map((session) => this.stopSession(session, 'stopped'))
      )
    })()
    return this.closePromise
  }

  private registerStart(ownerId: number, rootId: string): StartingSession {
    let resolveCancellation: () => void = () => undefined
    let resolveSettled: () => void = () => undefined
    const starting: StartingSession = {
      ownerId,
      rootId,
      cancelled: false,
      cancellation: new Promise<void>((resolve) => {
        resolveCancellation = resolve
      }),
      resolveCancellation: () => resolveCancellation(),
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve
      }),
      resolveSettled: () => resolveSettled()
    }
    this.startsByOwner.set(ownerId, starting)
    const rootStarts = this.startsByRoot.get(rootId) ?? new Set<StartingSession>()
    rootStarts.add(starting)
    this.startsByRoot.set(rootId, rootStarts)
    return starting
  }

  private finishStart(starting: StartingSession): void {
    if (this.startsByOwner.get(starting.ownerId) === starting) {
      this.startsByOwner.delete(starting.ownerId)
    }
    const rootStarts = this.startsByRoot.get(starting.rootId)
    rootStarts?.delete(starting)
    if (rootStarts?.size === 0) this.startsByRoot.delete(starting.rootId)
    starting.resolveSettled()
  }

  private cancelStart(starting: StartingSession): void {
    if (starting.cancelled) return
    starting.cancelled = true
    starting.resolveCancellation()
  }

  private isRootStopped(rootId: string): boolean {
    return (this.stoppedRootCounts.get(rootId) ?? 0) > 0
  }

  private assertStartAllowed(starting: StartingSession, owner: AgentTerminalOwner): void {
    if (this.closing || this.closedOwners.has(owner.id) || owner.isDestroyed()) {
      throw new Error('The PaperRelay window is closing.')
    }
    if (this.reloadingOwners.has(owner.id)) throw new Error('The PaperRelay view is reloading.')
    if (starting.cancelled || this.isRootStopped(starting.rootId)) {
      throw new Error('This research folder is being disconnected.')
    }
  }

  private async waitForStart<T>(
    starting: StartingSession,
    owner: AgentTerminalOwner,
    operation: Promise<T>
  ): Promise<T> {
    this.assertStartAllowed(starting, owner)
    const result = await Promise.race([
      operation.then((value) => ({ completed: true as const, value })),
      starting.cancellation.then(() => ({ completed: false as const }))
    ])
    this.assertStartAllowed(starting, owner)
    if (!result.completed) throw new Error('This research folder is being disconnected.')
    return result.value
  }

  private requireOwnedSession(ownerId: number, sessionIdValue: string): RunningSession {
    const sessionId = requiredSessionId(sessionIdValue)
    const session = this.sessionsById.get(sessionId)
    if (!session || session.owner.id !== ownerId) {
      throw new Error('This terminal session is no longer available in this window.')
    }
    return session
  }

  private handleOutput(session: RunningSession, unsafeData: string): void {
    if (session.finalized || session.requestedExitReason || typeof unsafeData !== 'string') return
    const data = session.filter.write(unsafeData)
    if (!data) return

    const remaining = this.maxOutputCharacters - session.outputCharacters
    const accepted = remaining > 0 ? data.slice(0, remaining) : ''
    session.outputCharacters += accepted.length
    for (let offset = 0; offset < accepted.length; offset += this.maxOutputChunkCharacters) {
      if (!this.sendOutput(session, accepted.slice(offset, offset + this.maxOutputChunkCharacters))) {
        void this.stopSession(session, 'error')
        return
      }
    }

    if (accepted.length !== data.length || session.outputCharacters >= this.maxOutputCharacters) {
      this.sendOutput(
        session,
        '\r\n[PaperRelay stopped this session after it exceeded the terminal output limit.]\r\n'
      )
      void this.stopSession(session, 'error')
    }
  }

  private sendOutput(session: RunningSession, data: string): boolean {
    if (!data || session.owner.isDestroyed()) return false
    try {
      session.owner.send(IPC.agentTerminalOutput, {
        sessionId: session.publicSession.id,
        data
      })
      return true
    } catch {
      return false
    }
  }

  private stopSession(
    session: RunningSession,
    reason: Exclude<AgentTerminalExitReason, 'exited'>
  ): Promise<void> {
    if (session.finalized) return Promise.resolve()
    if (session.stopPromise) {
      if (reason === 'error') session.requestedExitReason = 'error'
      return session.stopPromise
    }

    session.requestedExitReason = reason
    session.stopPromise = new Promise<void>((resolve) => {
      session.resolveStop = resolve
    })

    try {
      killAgentTerminalPty(session.pty, 'SIGTERM', this.platform)
    } catch {
      this.finalizeSession(session, null, null, reason)
      return session.stopPromise
    }
    if (session.finalized) return session.stopPromise

    session.terminateTimer = setTimeout(() => {
      if (session.finalized) return
      try {
        killAgentTerminalPty(session.pty, 'SIGKILL', this.platform)
      } catch {
        this.finalizeSession(session, null, null, session.requestedExitReason ?? reason)
        return
      }
      if (session.finalized) return
      session.killTimer = setTimeout(() => {
        this.finalizeSession(session, null, null, session.requestedExitReason ?? reason)
      }, this.killGraceMs)
      unrefTimer(session.killTimer)
    }, this.stopGraceMs)
    unrefTimer(session.terminateTimer)
    return session.stopPromise
  }

  private finalizeSession(
    session: RunningSession,
    exitCode: number | null,
    signal: number | null,
    reason: AgentTerminalExitReason
  ): void {
    if (session.finalized) return
    session.finalized = true
    if (session.terminateTimer) clearTimeout(session.terminateTimer)
    if (session.killTimer) clearTimeout(session.killTimer)
    session.terminateTimer = null
    session.killTimer = null
    this.sessionsById.delete(session.publicSession.id)
    if (this.sessionsByOwner.get(session.owner.id) === session) {
      this.sessionsByOwner.delete(session.owner.id)
    }
    try {
      session.dataDisposable?.dispose()
    } catch {
      // Listener cleanup is best-effort after the child has exited.
    }
    try {
      session.exitDisposable?.dispose()
    } catch {
      // Listener cleanup is best-effort after the child has exited.
    }

    if (!session.owner.isDestroyed()) {
      try {
        session.owner.send(IPC.agentTerminalExit, {
          sessionId: session.publicSession.id,
          exitCode,
          signal,
          reason
        })
      } catch {
        // A closing renderer may disappear before it receives the exit event.
      }
    }
    session.resolveStop?.()
    session.resolveStop = null
  }
}
