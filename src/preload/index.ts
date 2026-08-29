import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { LitRootBridge, ServiceEvent } from '../shared/contracts.js'
import { IPC } from '../shared/contracts.js'
import { paperAssetUrl } from './asset-url.js'

const bridge: LitRootBridge = {
  system: {
    listRuntimes: () => ipcRenderer.invoke(IPC.systemListRuntimes),
    diagnose: (target) => ipcRenderer.invoke(IPC.systemDiagnose, target),
    pickProjectPath: (target) => ipcRenderer.invoke(IPC.systemPickProjectPath, target),
    openExternal: (url) => ipcRenderer.invoke(IPC.systemOpenExternal, url),
    copyText: (text) => ipcRenderer.invoke(IPC.systemCopyText, text)
  },
  projects: {
    list: () => ipcRenderer.invoke(IPC.projectsList),
    add: (target, path, name) => ipcRenderer.invoke(IPC.projectsAdd, target, path, name),
    remove: (projectId) => ipcRenderer.invoke(IPC.projectsRemove, projectId),
    scan: (projectId) => ipcRenderer.invoke(IPC.projectsScan, projectId)
  },
  papers: {
    search: (request) => ipcRenderer.invoke(IPC.papersSearch, request),
    get: (projectId, paperId) => ipcRenderer.invoke(IPC.papersGet, projectId, paperId),
    updateMetadata: (request) => ipcRenderer.invoke(IPC.papersUpdateMetadata, request),
    markOpened: (projectId, paperId) => ipcRenderer.invoke(IPC.papersMarkOpened, projectId, paperId),
    openWindow: (projectId, paperId) => ipcRenderer.invoke(IPC.papersOpenWindow, projectId, paperId),
    reveal: (projectId, paperId) => ipcRenderer.invoke(IPC.papersReveal, projectId, paperId),
    export: (projectId, paperIds, includeImages) =>
      ipcRenderer.invoke(IPC.papersExport, projectId, paperIds, includeImages),
    copyImage: (projectId, paperId, source) =>
      ipcRenderer.invoke(IPC.papersCopyImage, projectId, paperId, source),
    assetUrl: paperAssetUrl
  },
  notes: {
    read: (request) => ipcRenderer.invoke(IPC.notesRead, request),
    write: (request) => ipcRenderer.invoke(IPC.notesWrite, request)
  },
  fetch: {
    create: (request) => ipcRenderer.invoke(IPC.fetchCreate, request),
    get: (projectId, runId) => ipcRenderer.invoke(IPC.fetchGet, projectId, runId),
    list: (projectId) => ipcRenderer.invoke(IPC.fetchList, projectId),
    cancel: (projectId, runId) => ipcRenderer.invoke(IPC.fetchCancel, projectId, runId),
    resume: (projectId, runId) => ipcRenderer.invoke(IPC.fetchResume, projectId, runId)
  },
  events: {
    subscribe: (listener) => {
      const receive = (_event: IpcRendererEvent, value: ServiceEvent): void => listener(value)
      ipcRenderer.on(IPC.eventsPush, receive)
      return () => ipcRenderer.removeListener(IPC.eventsPush, receive)
    }
  }
}

contextBridge.exposeInMainWorld('litroot', bridge)
