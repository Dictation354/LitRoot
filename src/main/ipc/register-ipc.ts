import { BrowserWindow, clipboard, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import {
  createFetchRunRequestSchema,
  IPC,
  metadataUpdateRequestSchema,
  noteReadRequestSchema,
  noteWriteRequestSchema,
  paperSearchRequestSchema
} from '../../shared/contracts.js'
import type { AppController } from '../app-controller.js'

const identifier = z.string().regex(/^[a-z]+_[a-f0-9]{24}$/)
const distribution = z.string().trim().min(1).max(200).refine((value) => !/[\0\r\n]/.test(value))

function authorize(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    BrowserWindow.fromWebContents(event.sender) !== window
  ) {
    throw new Error('该操作只允许 LitRoot 主窗口调用。')
  }
}

export function registerIpc(controller: AppController, window: BrowserWindow): void {
  const trusted = <T>(handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T) =>
    (event: IpcMainInvokeEvent, ...args: unknown[]): T => {
      authorize(event, window)
      return handler(event, ...args)
    }

  ipcMain.handle(IPC.systemListDistributions, trusted(() => controller.wsl.listDistributions()))
  ipcMain.handle(IPC.systemDiagnose, trusted((_event, value) =>
    controller.wsl.diagnose(distribution.parse(value))))
  ipcMain.handle(IPC.systemPickProjectPath, trusted((_event, value) =>
    controller.pickProjectPath(window, distribution.parse(value))))
  ipcMain.handle(IPC.systemOpenExternal, trusted(async (_event, value) => {
    const url = z.string().url().parse(value)
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('只允许打开无内嵌凭据的 HTTP(S) 地址。')
    }
    await shell.openExternal(parsed.toString())
  }))
  ipcMain.handle(IPC.systemCopyText, trusted((_event, value) => {
    clipboard.writeText(z.string().max(2_000_000).parse(value))
  }))

  ipcMain.handle(IPC.projectsList, trusted(() => controller.listProjects()))
  ipcMain.handle(IPC.projectsAdd, trusted((_event, distro, path, name) =>
    controller.addProject(
      distribution.parse(distro),
      z.string().trim().min(1).max(8_000).parse(path),
      z.string().trim().min(1).max(200).optional().parse(name)
    )))
  ipcMain.handle(IPC.projectsRemove, trusted((_event, value) =>
    controller.removeProject(identifier.parse(value))))
  ipcMain.handle(IPC.projectsScan, trusted((_event, value) =>
    controller.scan(identifier.parse(value))))

  ipcMain.handle(IPC.papersSearch, trusted((_event, value) =>
    controller.search(paperSearchRequestSchema.parse(value))))
  ipcMain.handle(IPC.papersGet, trusted((_event, projectId, paperId) =>
    controller.getPaper(identifier.parse(projectId), identifier.parse(paperId))))
  ipcMain.handle(IPC.papersUpdateMetadata, trusted((_event, value) =>
    controller.updateMetadata(metadataUpdateRequestSchema.parse(value))))

  ipcMain.handle(IPC.notesRead, trusted((_event, value) =>
    controller.readNote(noteReadRequestSchema.parse(value))))
  ipcMain.handle(IPC.notesWrite, trusted((_event, value) =>
    controller.writeNote(noteWriteRequestSchema.parse(value))))

  ipcMain.handle(IPC.fetchCreate, trusted((_event, value) =>
    controller.createFetch(createFetchRunRequestSchema.parse(value))))
  ipcMain.handle(IPC.fetchList, trusted((_event, projectId) =>
    controller.listFetch(identifier.parse(projectId))))
  ipcMain.handle(IPC.fetchGet, trusted((_event, projectId, runId) =>
    controller.getFetch(identifier.parse(projectId), identifier.parse(runId))))
  ipcMain.handle(IPC.fetchCancel, trusted((_event, projectId, runId) =>
    controller.cancelFetch(identifier.parse(projectId), identifier.parse(runId))))
  ipcMain.handle(IPC.fetchResume, trusted((_event, projectId, runId) =>
    controller.resumeFetch(identifier.parse(projectId), identifier.parse(runId))))
}

export function unregisterIpc(): void {
  for (const channel of Object.values(IPC)) ipcMain.removeHandler(channel)
}
