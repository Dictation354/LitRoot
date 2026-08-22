import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  nativeImage,
  protocol,
  session,
  shell,
  type NativeImage
} from 'electron'
import {
  AgentRelaySetupService,
  type AgentRelayRuntime
} from './application/agent-relay-setup.js'
import { AgentTerminalService } from './application/agent-terminal-service.js'
import { registerAgentTerminalReloadLifecycle } from './agent-terminal-window-lifecycle.js'
import { readAssetPreview } from './asset-preview.js'
import { LibraryService } from './application/library-service.js'
import { LibraryDatabase } from './db/library-database.js'
import { PaperUserDatabase } from './db/paper-user-database.js'
import { registerIpc, unregisterIpc } from './ipc/register-ipc.js'
import { safeExternalHttpUrl } from '../shared/external-url.js'
import { IPC, type AppCloseKind } from '../shared/contracts.js'
import { AppCloseCoordinator } from './app-close-coordinator.js'
import { denyRendererPermissions, developmentRendererUrl } from './electron-security.js'

let mainWindow: BrowserWindow | null = null
let service: LibraryService | null = null
let agentTerminal: AgentTerminalService | null = null
let closing = false
let readyToQuit = false
const allowedWindowCloses = new Set<number>()
const closeCoordinator = new AppCloseCoordinator()

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'paperrelay-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

async function serveAsset(request: Request): Promise<Response> {
  if (!service) return new Response('PaperRelay is not ready.', { status: 503 })
  const url = new URL(request.url)
  const [paperId, indexValue] = url.pathname.split('/').filter(Boolean)
  if (url.hostname !== 'preview' || !paperId || !indexValue) {
    return new Response('Invalid asset address.', { status: 400 })
  }
  const rootId = url.searchParams.get('rootId') ?? undefined
  const path = service.resolveAssetPath(decodeURIComponent(paperId), Number(indexValue), rootId)
  if (!path) return new Response('Asset not found.', { status: 404 })
  const asset = await readAssetPreview(path)
  if (!asset.ok) return new Response(asset.message, { status: asset.status })
  return new Response(asset.data, {
    status: 200,
    headers: {
      'Content-Type': asset.contentType,
      'Cache-Control': 'private, max-age=60'
    }
  })
}

function loadAppIcon(): NativeImage | undefined {
  const fileName = 'paperrelay-app-icon.png'
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, fileName), join(app.getAppPath(), 'resources', fileName)]
    : [join(app.getAppPath(), 'resources', fileName)]

  for (const path of candidates) {
    const image = nativeImage.createFromPath(path)
    if (!image.isEmpty()) return image
  }

  console.warn('PaperRelay app icon could not be loaded.')
  return undefined
}

function agentRelayRuntime(): AgentRelayRuntime | undefined {
  if (!app.isPackaged) return undefined
  const serverPath = join(process.resourcesPath, 'relay', 'paperrelay-relay.cjs')
  return {
    command: process.execPath,
    prefixArguments: [serverPath],
    serverPath,
    environment: { ELECTRON_RUN_AS_NODE: '1' },
    platform: process.platform
  }
}

function beginShutdown(): void {
  if (closing) return
  closing = true
  mainWindow?.hide()
  if (app.isReady()) protocol.unhandle('paperrelay-asset')
  unregisterIpc()
  const activeService = service
  const activeAgentTerminal = agentTerminal
  service = null
  agentTerminal = null
  void (async () => {
    await activeAgentTerminal?.close()
    await activeService?.close()
  })()
    .catch((error: unknown) => {
      console.error('PaperRelay could not finish closing cleanly:', error)
    })
    .finally(() => {
      readyToQuit = true
      app.exit(0)
    })
}

function requestRendererClose(kind: AppCloseKind, window = mainWindow): void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    if (kind === 'quit') beginShutdown()
    return
  }
  const request = closeCoordinator.request(kind, window.webContents.id)
  window.webContents.send(IPC.lifecycleCloseRequested, request)
}

function respondToRendererClose(
  window: BrowserWindow,
  requestId: string,
  proceed: boolean
): void {
  const resolution = closeCoordinator.resolve(requestId, window.webContents.id, proceed)
  if (resolution === 'stale') throw new Error('This close request is no longer active.')
  if (resolution === 'cancelled') return
  if (resolution === 'quit' || process.platform !== 'darwin') {
    beginShutdown()
    return
  }
  allowedWindowCloses.add(window.webContents.id)
  window.close()
}

function createWindow(icon?: NativeImage): void {
  const titleBarOptions =
    process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 18, y: 18 }
        }
      : process.platform === 'win32'
        ? {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: {
              color: '#f4f5f2',
              symbolColor: '#35474a',
              height: 42
            }
          }
        : { titleBarStyle: 'default' as const }
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#f4f5f2',
    ...(icon ? { icon } : {}),
    title: 'PaperRelay',
    ...titleBarOptions,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  mainWindow = window
  const terminalOwnerId = window.webContents.id
  registerAgentTerminalReloadLifecycle(
    window.webContents,
    terminalOwnerId,
    () => agentTerminal
  )

  window.on('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (allowedWindowCloses.delete(terminalOwnerId)) return
    event.preventDefault()
    requestRendererClose('window', window)
  })
  window.on('closed', () => {
    closeCoordinator.clearWindow(terminalOwnerId)
    void agentTerminal?.stopOwner(terminalOwnerId)
    if (mainWindow === window) mainWindow = null
  })
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`PaperRelay preload failed at ${preloadPath}:`, error)
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`PaperRelay renderer failed to load ${url} (${code}): ${description}`)
  })
  window.webContents.on('render-process-gone', () => {
    void agentTerminal?.stopOwner(terminalOwnerId)
  })
  window.webContents.on('destroyed', () => {
    void agentTerminal?.stopOwner(terminalOwnerId)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    const safeUrl = safeExternalHttpUrl(url)
    if (safeUrl) void shell.openExternal(safeUrl)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (current && url !== current) event.preventDefault()
  })

  const rendererUrl = developmentRendererUrl(app.isPackaged, process.env.ELECTRON_RENDERER_URL)
  if (rendererUrl) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.setName('PaperRelay')
if (process.platform === 'win32') app.setAppUserModelId('io.paperrelay.desktop')
if (process.env.PAPERRELAY_DATA_DIR) app.setPath('userData', process.env.PAPERRELAY_DATA_DIR)

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    denyRendererPermissions(session.defaultSession)
    const icon = loadAppIcon()
    if (process.platform === 'darwin' && icon && app.dock) app.dock.setIcon(icon)

    const dataDirectory = app.getPath('userData')
    const databasePath = join(dataDirectory, 'paperrelay.sqlite3')
    const database = new LibraryDatabase(databasePath)
    let userDatabase: PaperUserDatabase
    try {
      userDatabase = new PaperUserDatabase(join(dataDirectory, 'paperrelay-user.sqlite3'))
    } catch (error) {
      database.close()
      throw error
    }
    service = new LibraryService(database, userDatabase)
    service.initialize()
    agentTerminal = new AgentTerminalService(service)
    const relayRuntime = agentRelayRuntime()
    registerIpc(
      service,
      new AgentRelaySetupService(
        service,
        databasePath,
        app.getAppPath(),
        undefined,
        relayRuntime ? { runtime: relayRuntime } : {}
      ),
      agentTerminal,
      () => mainWindow,
      { respond: respondToRendererClose }
    )
    await protocol.handle('paperrelay-asset', serveAsset)
    createWindow(icon)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(icon)
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (readyToQuit) return
  event.preventDefault()
  if (closing) return
  requestRendererClose('quit')
})
