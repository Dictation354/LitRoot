import { BrowserWindow, clipboard, ipcMain, nativeImage, shell, type IpcMainInvokeEvent } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  type BridgeErrorPayload,
  type BridgeResult,
  createFetchRunRequestSchema,
  addFeedRequestSchema,
  feedItemsRequestSchema,
  IPC,
  metadataUpdateRequestSchema,
  noteReadRequestSchema,
  noteWriteRequestSchema,
  markFeedReadRequestSchema,
  journalSearchRequestSchema,
  paperSearchRequestSchema,
  runtimeTargetSchema
} from '../../shared/contracts.js'
import type { AppController } from '../app-controller.js'
import { ServiceClientError } from '../service-client.js'

const identifier = z.string().regex(/^[a-z]+_[a-f0-9]{24}$/)
const imageDirectories = new Set<string>()

function authorize(event: IpcMainInvokeEvent, windows: () => BrowserWindow[]): void {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (
    !window || !windows().includes(window) ||
    event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error('该操作只允许 LitRoot 受管窗口调用。')
  }
}

function errorPayload(error: unknown): BridgeErrorPayload {
  if (error instanceof ServiceClientError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details })
    }
  }
  return {
    code: 'internal_error',
    message: error instanceof Error ? error.message : '操作失败。'
  }
}

export function registerIpc(
  controller: AppController,
  windows: () => BrowserWindow[],
  openPaperWindow: (projectId: string, paperId: string) => Promise<void>
): void {
  const trusted = <T>(handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T) =>
    async (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ): Promise<BridgeResult<Awaited<T> extends void ? null : Awaited<T>>> => {
      try {
        authorize(event, windows)
        const value = await handler(event, ...args)
        return {
          ok: true,
          value: (value === undefined ? null : value) as Awaited<T> extends void ? null : Awaited<T>
        }
      } catch (error) {
        return { ok: false, error: errorPayload(error) }
      }
    }

  ipcMain.handle(IPC.systemListRuntimes, trusted(() => controller.runtimes.listRuntimes()))
  ipcMain.handle(IPC.systemDiagnose, trusted((_event, value) =>
    controller.runtimes.diagnose(runtimeTargetSchema.parse(value))))
  ipcMain.handle(IPC.systemPickProjectPath, trusted((_event, value) =>
    controller.pickProjectPath(BrowserWindow.fromWebContents(_event.sender)!, runtimeTargetSchema.parse(value))))
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
  ipcMain.handle(IPC.projectsAdd, trusted((_event, target, path, name) =>
    controller.addProject(
      runtimeTargetSchema.parse(target),
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
  ipcMain.handle(IPC.papersMarkOpened, trusted((_event, projectId, paperId) =>
    controller.markPaperOpened(identifier.parse(projectId), identifier.parse(paperId))))
  ipcMain.handle(IPC.papersOpenWindow, trusted(async (_event, projectId, paperId) => {
    const parsedProjectId = identifier.parse(projectId)
    const parsedPaperId = identifier.parse(paperId)
    await controller.markPaperOpened(parsedProjectId, parsedPaperId)
    await openPaperWindow(parsedProjectId, parsedPaperId)
  }))
  ipcMain.handle(IPC.papersReveal, trusted(async (_event, projectId, paperId) => {
    const path = await controller.paperHostPath(identifier.parse(projectId), identifier.parse(paperId))
    shell.showItemInFolder(path)
  }))
  ipcMain.handle(IPC.papersExport, trusted((_event, projectId, paperIds, includeImages) =>
    controller.exportPapers(
      BrowserWindow.fromWebContents(_event.sender)!,
      identifier.parse(projectId),
      z.array(identifier).min(1).max(50).parse(paperIds),
      z.boolean().parse(includeImages)
    )))
  ipcMain.handle(IPC.papersCopyImage, trusted(async (_event, projectId, paperId, source) => {
    const response = await controller.asset(
      identifier.parse(projectId),
      identifier.parse(paperId),
      z.string().min(1).max(8_000).parse(source)
    )
    if (!response.ok) throw new Error('图片不存在或不允许访问。')
    const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()))
    if (image.isEmpty()) throw new Error('无法解码这张图片。')
    clipboard.writeImage(image)
  }))
  ipcMain.handle(IPC.papersOpenImage, trusted(async (_event, projectId, paperId, source) => {
    const response = await controller.asset(
      identifier.parse(projectId),
      identifier.parse(paperId),
      z.string().min(1).max(8_000).parse(source)
    )
    if (!response.ok) throw new Error('图片不存在或不允许访问。')
    const extensions = new Map([
      ['image/png', 'png'],
      ['image/jpeg', 'jpg'],
      ['image/gif', 'gif'],
      ['image/webp', 'webp'],
      ['image/avif', 'avif']
    ])
    const extension = extensions.get(response.headers.get('content-type') ?? '')
    if (!extension) throw new Error('不支持的图片格式。')
    const data = Buffer.from(await response.arrayBuffer())
    const directory = mkdtempSync(join(tmpdir(), 'litroot-image-'))
    imageDirectories.add(directory)
    try {
      const path = join(directory, `image.${extension}`)
      await writeFile(path, data, { flag: 'wx', mode: 0o600 })
      const error = await shell.openPath(path)
      if (error) throw new Error(`打开图片失败：${error}`)
    } catch (error) {
      try {
        rmSync(directory, { recursive: true, force: true })
        imageDirectories.delete(directory)
      } catch {
        // Retry cleanup when the application exits.
      }
      throw error
    }
  }))

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
  ipcMain.handle(IPC.fetchCancelItem, trusted((_event, projectId, runId, index) =>
    controller.cancelFetchItem(identifier.parse(projectId), identifier.parse(runId), z.number().int().min(1).parse(index))))
  ipcMain.handle(IPC.fetchResume, trusted((_event, projectId, runId) =>
    controller.resumeFetch(identifier.parse(projectId), identifier.parse(runId))))

  const feedIdentifier = z.string().regex(/^feed_[a-f0-9]{24}$/)
  ipcMain.handle(IPC.feedsList, trusted(() => controller.listFeeds()))
  ipcMain.handle(IPC.feedsSearchJournals, trusted((_event, value) =>
    controller.searchJournals(journalSearchRequestSchema.parse(value))))
  ipcMain.handle(IPC.feedsAdd, trusted((_event, value) =>
    controller.addFeed(addFeedRequestSchema.parse(value))))
  ipcMain.handle(IPC.feedsRemove, trusted((_event, subscriptionId) =>
    controller.removeFeed(feedIdentifier.parse(subscriptionId))))
  ipcMain.handle(IPC.feedsRefresh, trusted((_event, subscriptionId) =>
    controller.refreshFeed(feedIdentifier.parse(subscriptionId))))
  ipcMain.handle(IPC.feedsItems, trusted((_event, value) =>
    controller.feedItems(feedItemsRequestSchema.parse(value))))
  ipcMain.handle(IPC.feedsMarkRead, trusted((_event, value) =>
    controller.markFeedRead(markFeedReadRequestSchema.parse(value))))
}

export function unregisterIpc(): void {
  for (const channel of Object.values(IPC)) ipcMain.removeHandler(channel)
  for (const directory of imageDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // An external viewer may still hold the file open; do not block exit.
    }
  }
  imageDirectories.clear()
}
