import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AppCloseRequest,
  AgentTerminalExit,
  AgentTerminalOutput,
  PaperRelayBridge
} from '../shared/contracts.js'
import { IPC } from '../shared/contracts.js'

const bridge: PaperRelayBridge = {
  library: {
    summary: () => ipcRenderer.invoke(IPC.librarySummary)
  },
  roots: {
    list: () => ipcRenderer.invoke(IPC.rootsList),
    addWithPicker: () => ipcRenderer.invoke(IPC.rootsAddWithPicker),
    rescan: (rootId) => ipcRenderer.invoke(IPC.rootsRescan, rootId),
    remove: (rootId) => ipcRenderer.invoke(IPC.rootsRemove, rootId)
  },
  papers: {
    search: (request) => ipcRenderer.invoke(IPC.papersSearch, request),
    get: (paperId, rootId) => ipcRenderer.invoke(IPC.papersGet, paperId, rootId),
    issues: (rootId) => ipcRenderer.invoke(IPC.papersIssues, rootId),
    updateUserState: (paperId, patch) =>
      ipcRenderer.invoke(IPC.papersUpdateUserState, paperId, patch),
    saveDraft: (paperId, draft) => ipcRenderer.invoke(IPC.papersSaveDraft, paperId, draft),
    discardDraft: (paperId) => ipcRenderer.invoke(IPC.papersDiscardDraft, paperId),
    commitDraft: (paperId) => ipcRenderer.invoke(IPC.papersCommitDraft, paperId),
    markOpened: (paperId) => ipcRenderer.invoke(IPC.papersMarkOpened, paperId)
  },
  insights: {
    paper: (paperId, rootId) => ipcRenderer.invoke(IPC.insightsPaper, paperId, rootId),
    landscape: (request) => ipcRenderer.invoke(IPC.insightsLandscape, request)
  },
  agentRelay: {
    setup: () => ipcRenderer.invoke(IPC.agentRelaySetup),
    copyCodexConfig: () => ipcRenderer.invoke(IPC.agentRelayCopyCodexConfig),
    copyTestPrompt: () => ipcRenderer.invoke(IPC.agentRelayCopyTestPrompt),
    copyPaperReference: (paperId, rootId) =>
      ipcRenderer.invoke(IPC.agentRelayCopyPaperReference, paperId, rootId),
    copyRootContext: (rootId) => ipcRenderer.invoke(IPC.agentRelayCopyRootContext, rootId)
  },
  agentTerminal: {
    start: (request) => ipcRenderer.invoke(IPC.agentTerminalStart, request),
    write: (sessionId, data) => ipcRenderer.invoke(IPC.agentTerminalWrite, sessionId, data),
    resize: (sessionId, cols, rows) =>
      ipcRenderer.invoke(IPC.agentTerminalResize, sessionId, cols, rows),
    stop: (sessionId) => ipcRenderer.invoke(IPC.agentTerminalStop, sessionId),
    onOutput: (listener) => {
      const receiveOutput = (_event: IpcRendererEvent, payload: AgentTerminalOutput): void => {
        listener(payload)
      }
      ipcRenderer.on(IPC.agentTerminalOutput, receiveOutput)
      return () => ipcRenderer.removeListener(IPC.agentTerminalOutput, receiveOutput)
    },
    onExit: (listener) => {
      const receiveExit = (_event: IpcRendererEvent, payload: AgentTerminalExit): void => {
        listener(payload)
      }
      ipcRenderer.on(IPC.agentTerminalExit, receiveExit)
      return () => ipcRenderer.removeListener(IPC.agentTerminalExit, receiveExit)
    }
  },
  lifecycle: {
    respondToClose: (requestId, proceed) =>
      ipcRenderer.invoke(IPC.lifecycleRespondToClose, requestId, proceed),
    onCloseRequested: (listener) => {
      const receiveRequest = (_event: IpcRendererEvent, request: AppCloseRequest): void => {
        listener(request)
      }
      ipcRenderer.on(IPC.lifecycleCloseRequested, receiveRequest)
      return () => ipcRenderer.removeListener(IPC.lifecycleCloseRequested, receiveRequest)
    }
  },
  system: {
    revealLocation: (locationId) => ipcRenderer.invoke(IPC.systemRevealLocation, locationId)
  }
}

contextBridge.exposeInMainWorld('paperrelay', bridge)
