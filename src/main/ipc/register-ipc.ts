import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent
} from 'electron'
import type {
  AgentRelaySetup,
  AgentTerminalStartRequest,
  PaperSearchRequest,
  PaperUserDraftInput,
  PaperUserStatePatch,
  ResearchLandscapeRequest
} from '../../shared/contracts.js'
import { IPC } from '../../shared/contracts.js'
import type { AgentRelaySetupService } from '../application/agent-relay-setup.js'
import type {
  AgentTerminalOwner,
  AgentTerminalService
} from '../application/agent-terminal-service.js'
import type { LibraryService } from '../application/library-service.js'
import {
  MAX_PAPER_USER_NOTE_LENGTH,
  MAX_PAPER_USER_TAG_INPUT_LENGTH,
  MAX_PAPER_USER_TAG_LENGTH,
  MAX_PAPER_USER_TAGS
} from '../db/paper-user-database.js'

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`)
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requiredPaperId(value: unknown): string {
  const paperId = requiredString(value, 'Paper')
  if (paperId.length > 200) throw new Error('Paper identifier is too long.')
  return paperId
}

function requiredTerminalSessionId(value: unknown): string {
  const sessionId = requiredString(value, 'Terminal session')
  if (sessionId.length > 200) throw new Error('Terminal session is invalid.')
  return sessionId
}

function terminalStartRequest(value: unknown): AgentTerminalStartRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent terminal settings must be an object.')
  }
  const input = value as Record<string, unknown>
  const supportedKeys = new Set(['rootId', 'access', 'cols', 'rows'])
  if (Object.keys(input).some((key) => !supportedKeys.has(key))) {
    throw new Error('Agent terminal settings contain an unsupported field.')
  }
  const request: AgentTerminalStartRequest = {
    rootId: requiredString(input.rootId, 'Research folder')
  }
  if (request.rootId.length > 200) throw new Error('Research folder identifier is too long.')
  if (input.access !== undefined) {
    if (input.access !== 'read-only' && input.access !== 'workspace-write') {
      throw new Error('Agent terminal access mode is invalid.')
    }
    request.access = input.access
  }
  for (const dimension of ['cols', 'rows'] as const) {
    const setting = input[dimension]
    if (setting === undefined) continue
    if (typeof setting !== 'number' || !Number.isFinite(setting)) {
      throw new Error(`Terminal ${dimension} must be a finite number.`)
    }
    request[dimension] = setting
  }
  return request
}

function searchRequest(value: unknown): PaperSearchRequest {
  if (!value || typeof value !== 'object') return {}
  const request = value as Record<string, unknown>
  const result: PaperSearchRequest = {}
  const query = optionalString(request.query)
  const rootId = optionalString(request.rootId)
  if (query) result.query = query.slice(0, 500)
  if (rootId) result.rootId = rootId
  if (typeof request.attention === 'boolean') result.attention = request.attention
  if (request.sort === 'updated' || request.sort === 'title' || request.sort === 'year') {
    result.sort = request.sort
  }
  if (typeof request.limit === 'number' && Number.isFinite(request.limit)) {
    result.limit = Math.min(500, Math.max(1, Math.trunc(request.limit)))
  }
  if (typeof request.offset === 'number' && Number.isFinite(request.offset)) {
    result.offset = Math.min(1_000_000, Math.max(0, Math.trunc(request.offset)))
  }
  if (
    request.userView === 'favorites' ||
    request.userView === 'reading_list' ||
    request.userView === 'reviewed'
  ) {
    result.userView = request.userView
  }
  return result
}

function userStatePatch(value: unknown): PaperUserStatePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('User state changes must be an object.')
  }
  const input = value as Record<string, unknown>
  const patch: PaperUserStatePatch = {}
  if (Object.hasOwn(input, 'favorite')) {
    if (typeof input.favorite !== 'boolean') throw new Error('Favorite must be true or false.')
    patch.favorite = input.favorite
  }
  if (Object.hasOwn(input, 'readingStatus')) {
    if (
      input.readingStatus !== 'none' &&
      input.readingStatus !== 'to_read' &&
      input.readingStatus !== 'reading' &&
      input.readingStatus !== 'reviewed'
    ) {
      throw new Error('Reading status is invalid.')
    }
    patch.readingStatus = input.readingStatus
  }
  if (Object.hasOwn(input, 'tags')) {
    if (!Array.isArray(input.tags)) throw new Error('Tags must be an array.')
    if (input.tags.length > MAX_PAPER_USER_TAGS) {
      throw new Error(`A paper can have at most ${MAX_PAPER_USER_TAGS} tags.`)
    }
    patch.tags = input.tags.map((tag) => {
      if (typeof tag !== 'string') throw new Error('Every tag must be text.')
      const trimmed = tag.trim()
      if (trimmed.length > MAX_PAPER_USER_TAG_LENGTH) {
        throw new Error(`Each tag can be at most ${MAX_PAPER_USER_TAG_LENGTH} characters.`)
      }
      return trimmed
    })
  }
  if (Object.hasOwn(input, 'note')) {
    if (typeof input.note !== 'string') throw new Error('Private note must be text.')
    if (input.note.length > MAX_PAPER_USER_NOTE_LENGTH) {
      throw new Error(`Private note can be at most ${MAX_PAPER_USER_NOTE_LENGTH} characters.`)
    }
    patch.note = input.note
  }
  return patch
}

function userDraftInput(value: unknown): PaperUserDraftInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Draft changes must be an object.')
  }
  const input = value as Record<string, unknown>
  const supportedKeys = new Set(['note', 'tagInput'])
  if (Object.keys(input).some((key) => !supportedKeys.has(key))) {
    throw new Error('Draft changes contain an unsupported field.')
  }
  if (typeof input.note !== 'string') throw new Error('Draft note must be text.')
  if (input.note.length > MAX_PAPER_USER_NOTE_LENGTH) {
    throw new Error(`Draft note can be at most ${MAX_PAPER_USER_NOTE_LENGTH} characters.`)
  }
  if (typeof input.tagInput !== 'string') throw new Error('Draft tags must be text.')
  if (input.tagInput.length > MAX_PAPER_USER_TAG_INPUT_LENGTH) {
    throw new Error(
      `Draft tags can be at most ${MAX_PAPER_USER_TAG_INPUT_LENGTH} characters.`
    )
  }
  return { note: input.note, tagInput: input.tagInput }
}

function researchLandscapeRequest(value: unknown): ResearchLandscapeRequest {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Research landscape settings must be an object.')
  }
  const input = value as Record<string, unknown>
  const supportedKeys = new Set(['rootId', 'limit'])
  if (Object.keys(input).some((key) => !supportedKeys.has(key))) {
    throw new Error('Research landscape settings contain an unsupported field.')
  }
  const request: ResearchLandscapeRequest = {}
  if (input.rootId !== undefined) {
    const rootId = requiredString(input.rootId, 'Research folder')
    if (rootId.length > 200) throw new Error('Research folder identifier is too long.')
    request.rootId = rootId
  }
  if (input.limit !== undefined) {
    if (typeof input.limit !== 'number' || !Number.isFinite(input.limit)) {
      throw new Error('Research landscape limit must be a finite number.')
    }
    const limit = Math.trunc(input.limit)
    if (limit < 1 || limit > 200) {
      throw new Error('Research landscape limit must be between 1 and 200.')
    }
    request.limit = limit
  }
  return request
}

async function readyAgentRelay(agentRelay: AgentRelaySetupService): Promise<AgentRelaySetup> {
  const setup = await agentRelay.setup()
  if (!setup.available) throw new Error(setup.error ?? 'The local Agent Relay is unavailable.')
  return setup
}

export type MainWindowProvider = () => BrowserWindow | null

export interface AppLifecycleResponder {
  respond(window: BrowserWindow, requestId: string, proceed: boolean): void
}

function trustedMainWindow(
  event: IpcMainInvokeEvent,
  mainWindow: MainWindowProvider
): BrowserWindow {
  const window = mainWindow()
  if (
    !window ||
    window.isDestroyed() ||
    event.sender.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    BrowserWindow.fromWebContents(event.sender) !== window
  ) {
    throw new Error('This action is only available to the active PaperRelay window.')
  }
  return window
}

export function registerIpc(
  service: LibraryService,
  agentRelay: AgentRelaySetupService,
  agentTerminal: AgentTerminalService,
  mainWindow: MainWindowProvider,
  lifecycle?: AppLifecycleResponder
): void {
  const terminalStarts = new Set<number>()
  const authorize = (event: IpcMainInvokeEvent): BrowserWindow =>
    trustedMainWindow(event, mainWindow)

  ipcMain.handle(IPC.librarySummary, (event) => {
    authorize(event)
    return service.summary()
  })
  ipcMain.handle(IPC.rootsList, (event) => {
    authorize(event)
    return service.listRoots()
  })
  ipcMain.handle(IPC.rootsAddWithPicker, async (event) => {
    const window = authorize(event)
    const result = await dialog.showOpenDialog(window, {
      title: 'Connect a research folder',
      buttonLabel: 'Connect folder',
      properties: ['openDirectory'],
      message: 'PaperRelay will index supported research artifacts without changing the folder.'
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
    authorize(event)
    return service.addRoot(path)
  })
  ipcMain.handle(IPC.rootsRescan, (event, rootId: unknown) => {
    authorize(event)
    return service.rescan(requiredString(rootId, 'Research folder'))
  })
  ipcMain.handle(IPC.rootsRemove, async (event, rootId: unknown) => {
    authorize(event)
    const selectedRootId = requiredString(rootId, 'Research folder')
    try {
      await agentTerminal.stopRoot(selectedRootId)
      return await service.removeRoot(selectedRootId)
    } finally {
      agentTerminal.releaseRootStop(selectedRootId)
    }
  })
  ipcMain.handle(IPC.papersSearch, (event, request: unknown) => {
    authorize(event)
    return service.searchPapers(searchRequest(request))
  })
  ipcMain.handle(IPC.papersGet, (event, paperId: unknown, rootId: unknown) => {
    authorize(event)
    return service.getPaper(requiredPaperId(paperId), optionalString(rootId))
  })
  ipcMain.handle(IPC.papersIssues, (event, rootId: unknown) => {
    authorize(event)
    return service.listIssues(optionalString(rootId))
  })
  ipcMain.handle(IPC.papersUpdateUserState, (event, paperId: unknown, patch: unknown) => {
    authorize(event)
    return service.updateUserState(requiredPaperId(paperId), userStatePatch(patch))
  })
  ipcMain.handle(IPC.papersSaveDraft, (event, paperId: unknown, draft: unknown) => {
    authorize(event)
    return service.saveDraft(requiredPaperId(paperId), userDraftInput(draft))
  })
  ipcMain.handle(IPC.papersDiscardDraft, (event, paperId: unknown) => {
    authorize(event)
    return service.discardDraft(requiredPaperId(paperId))
  })
  ipcMain.handle(IPC.papersCommitDraft, (event, paperId: unknown) => {
    authorize(event)
    return service.commitDraft(requiredPaperId(paperId))
  })
  ipcMain.handle(IPC.papersMarkOpened, (event, paperId: unknown) => {
    authorize(event)
    return service.markOpened(requiredPaperId(paperId))
  })
  ipcMain.handle(IPC.insightsPaper, (event, paperId: unknown, rootId: unknown) => {
    authorize(event)
    return service.paperDigest(requiredPaperId(paperId), optionalString(rootId))
  })
  ipcMain.handle(IPC.insightsLandscape, (event, request: unknown) => {
    authorize(event)
    return service.researchLandscape(researchLandscapeRequest(request))
  })
  ipcMain.handle(IPC.agentRelaySetup, (event) => {
    authorize(event)
    return agentRelay.setup()
  })
  ipcMain.handle(IPC.agentRelayCopyCodexConfig, async (event) => {
    authorize(event)
    const setup = await readyAgentRelay(agentRelay)
    authorize(event)
    clipboard.writeText(setup.codexConfig)
  })
  ipcMain.handle(IPC.agentRelayCopyTestPrompt, async (event) => {
    authorize(event)
    const setup = await readyAgentRelay(agentRelay)
    authorize(event)
    clipboard.writeText(setup.testPrompt)
  })
  ipcMain.handle(
    IPC.agentRelayCopyPaperReference,
    (event, paperId: unknown, rootId: unknown) => {
      authorize(event)
      clipboard.writeText(
        agentRelay.paperReference(requiredString(paperId, 'Paper'), optionalString(rootId))
      )
    }
  )
  ipcMain.handle(IPC.agentRelayCopyRootContext, (event, rootId: unknown) => {
    authorize(event)
    clipboard.writeText(agentRelay.rootContext(requiredString(rootId, 'Research folder')))
  })
  ipcMain.handle(IPC.agentTerminalStart, async (event, value: unknown) => {
    const window = authorize(event)
    const ownerId = event.sender.id
    if (terminalStarts.has(ownerId) || agentTerminal.isOwnerBusy(ownerId)) {
      throw new Error('This window already has an active or starting agent session.')
    }
    terminalStarts.add(ownerId)
    try {
      const request = terminalStartRequest(value)
      const accessMode = request.access ?? 'read-only'
      if (accessMode === 'workspace-write') {
        const root = service.listRoots().find((candidate) => candidate.id === request.rootId)
        if (!root) throw new Error('This research folder is no longer registered.')
        const confirmation = await dialog.showMessageBox(window, {
          type: 'warning',
          title: 'Allow Codex to edit this project?',
          message: 'Allow Codex to edit this research folder?',
          detail: [
            root.label,
            root.path,
            '',
            'Codex may create, change, or delete files inside this folder. It may later show separate approval prompts for broader actions; review each prompt before allowing it. PaperRelay will continue to treat indexed papers as research data.'
          ].join('\n'),
          buttons: ['Cancel', 'Allow editing'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        if (confirmation.response !== 1) return null
      }
      authorize(event)
      return agentTerminal.start(event.sender as AgentTerminalOwner, request)
    } finally {
      terminalStarts.delete(ownerId)
    }
  })
  ipcMain.handle(IPC.agentTerminalWrite, (event, sessionId: unknown, data: unknown) => {
    authorize(event)
    if (typeof data !== 'string') throw new Error('Terminal input must be text.')
    agentTerminal.write(event.sender.id, requiredTerminalSessionId(sessionId), data)
  })
  ipcMain.handle(
    IPC.agentTerminalResize,
    (event, sessionId: unknown, cols: unknown, rows: unknown) => {
      authorize(event)
      if (typeof cols !== 'number' || !Number.isFinite(cols)) {
        throw new Error('Terminal columns must be a finite number.')
      }
      if (typeof rows !== 'number' || !Number.isFinite(rows)) {
        throw new Error('Terminal rows must be a finite number.')
      }
      agentTerminal.resize(event.sender.id, requiredTerminalSessionId(sessionId), cols, rows)
    }
  )
  ipcMain.handle(IPC.agentTerminalStop, (event, sessionId: unknown) => {
    authorize(event)
    return agentTerminal.stop(event.sender.id, requiredTerminalSessionId(sessionId))
  })
  ipcMain.handle(
    IPC.lifecycleRespondToClose,
    (event, requestIdValue: unknown, proceedValue: unknown) => {
      const window = authorize(event)
      if (!lifecycle) throw new Error('Application lifecycle coordination is unavailable.')
      const requestId = requiredString(requestIdValue, 'Close request')
      if (requestId.length > 200) throw new Error('Close request is invalid.')
      if (typeof proceedValue !== 'boolean') {
        throw new Error('Close response must be true or false.')
      }
      lifecycle.respond(window, requestId, proceedValue)
    }
  )
  ipcMain.handle(IPC.systemRevealLocation, (event, locationId: unknown) => {
    authorize(event)
    const path = service.resolveLocationPath(requiredString(locationId, 'Location'))
    if (!path) throw new Error('This source location is no longer registered.')
    shell.showItemInFolder(path)
  })
}

export function unregisterIpc(): void {
  for (const channel of Object.values(IPC)) ipcMain.removeHandler(channel)
}
