import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  nativeImage,
  protocol,
  session
} from 'electron'
import { AppController } from './app-controller.js'
import { denyRendererPermissions, developmentRendererUrl } from './electron-security.js'
import { registerIpc, unregisterIpc } from './ipc/register-ipc.js'
import { IPC } from '../shared/contracts.js'

let mainWindow: BrowserWindow | null = null
let controller: AppController | null = null
const managedWindows = new Set<BrowserWindow>()
const readerWindows = new Map<string, BrowserWindow>()
const singleInstance = app.requestSingleInstanceLock()

if (!singleInstance) app.quit()
app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'litroot-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

function assetRequest(urlString: string): { projectId: string; paperId: string; source: string } | null {
  try {
    const url = new URL(urlString)
    if (url.protocol !== 'litroot-asset:' || url.hostname !== 'paper') return null
    const encoded = url.pathname.replace(/^\//, '')
    if (!encoded || encoded.length > 20_000) return null
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (
      typeof record.projectId !== 'string' || !/^project_[a-f0-9]{24}$/.test(record.projectId) ||
      typeof record.paperId !== 'string' || !/^paper_[a-f0-9]{24}$/.test(record.paperId) ||
      typeof record.source !== 'string' || record.source.length > 8_000
    ) return null
    return { projectId: record.projectId, paperId: record.paperId, source: record.source }
  } catch {
    return null
  }
}

async function registerAssetProtocol(): Promise<void> {
  await protocol.handle('litroot-asset', async (request) => {
    const parsed = assetRequest(request.url)
    if (!parsed || !controller) return new Response('Not found', { status: 404 })
    try {
      const response = await controller.asset(parsed.projectId, parsed.paperId, parsed.source)
      if (!response.ok) return new Response('Not found', { status: 404 })
      return response
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function secureWindow(window: BrowserWindow): void {
  managedWindows.add(window)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    const developmentUrl = developmentRendererUrl(app.isPackaged, process.env.ELECTRON_RENDERER_URL)
    let allowed = false
    if (developmentUrl) {
      try {
        allowed = new URL(url).origin === new URL(developmentUrl).origin
      } catch {
        allowed = false
      }
    }
    if (!allowed) event.preventDefault()
  })
  window.on('closed', () => managedWindows.delete(window))
}

function loadRenderer(window: BrowserWindow, query?: Record<string, string>): void {
  const developmentUrl = developmentRendererUrl(app.isPackaged, process.env.ELECTRON_RENDERER_URL)
  if (developmentUrl) {
    const url = new URL(developmentUrl)
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), query ? { query } : undefined)
  }
}

function windowPreferences() {
  return {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    devTools: !app.isPackaged
  }
}

function createWindow(): BrowserWindow {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'litroot-app-icon.png')
    : join(app.getAppPath(), 'resources', 'litroot-app-icon.png')
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#f5f3ed',
    title: 'LitRoot',
    icon: nativeImage.createFromPath(iconPath),
    webPreferences: windowPreferences()
  })
  secureWindow(window)
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow !== window) return
    mainWindow = null
    for (const reader of readerWindows.values()) reader.close()
  })
  loadRenderer(window)
  return window
}

async function openPaperWindow(projectId: string, paperId: string): Promise<void> {
  const key = `${projectId}:${paperId}`
  const existing = readerWindows.get(key)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'litroot-app-icon.png')
    : join(app.getAppPath(), 'resources', 'litroot-app-icon.png')
  const window = new BrowserWindow({
    width: 1080,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#f5f3ed',
    title: 'LitRoot 阅读器',
    icon: nativeImage.createFromPath(iconPath),
    webPreferences: windowPreferences()
  })
  readerWindows.set(key, window)
  secureWindow(window)
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (readerWindows.get(key) === window) readerWindows.delete(key)
  })
  loadRenderer(window, { readerProjectId: projectId, readerPaperId: paperId })
}

async function start(): Promise<void> {
  denyRendererPermissions(session.defaultSession)
  controller = new AppController((event) => {
    for (const window of managedWindows) {
      if (!window.isDestroyed()) window.webContents.send(IPC.eventsPush, event)
    }
  })
  await controller.start()
  await registerAssetProtocol()
  mainWindow = createWindow()
  registerIpc(controller, () => [...managedWindows], openPaperWindow)
}

app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
  event.preventDefault()
  callback(false)
})

if (singleInstance) {
  app.whenReady().then(start).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    app.quit()
  })
}

app.on('window-all-closed', () => app.quit())

app.on('before-quit', () => {
  unregisterIpc()
  protocol.unhandle('litroot-asset')
  void controller?.close()
})
