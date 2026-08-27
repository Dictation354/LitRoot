import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

const workspacePath = join(import.meta.dirname, '..')
const preloadPath = join(workspacePath, 'out', 'preload', 'index.js')
const source = await readFile(preloadPath, 'utf8')
const encodings = []
let exposedBridge

const sandboxBuffer = {
  from(value, encoding) {
    const bytes = Buffer.from(value, encoding)
    return {
      toString(outputEncoding) {
        encodings.push(outputEncoding)
        if (outputEncoding === 'base64url') {
          throw new Error('Electron sandbox Buffer does not support base64url')
        }
        return bytes.toString(outputEncoding)
      }
    }
  }
}

const ipcRenderer = {
  invoke: async () => undefined,
  on: () => ipcRenderer,
  removeListener: () => ipcRenderer
}

runInNewContext(source, {
  Buffer: sandboxBuffer,
  console,
  require(specifier) {
    assert.equal(specifier, 'electron', `unexpected preload dependency: ${specifier}`)
    return {
      contextBridge: {
        exposeInMainWorld(name, bridge) {
          assert.equal(name, 'litroot')
          exposedBridge = bridge
        }
      },
      ipcRenderer
    }
  }
}, { filename: preloadPath })

assert.ok(exposedBridge, 'packaged preload did not expose the LitRoot bridge')
const request = {
  projectId: 'project_aaaaaaaaaaaaaaaaaaaaaaaa',
  paperId: 'paper_bbbbbbbbbbbbbbbbbbbbbbbb',
  source: 'figures/结果 ①.png'
}
const url = exposedBridge.papers.assetUrl(request.projectId, request.paperId, request.source)
const prefix = 'litroot-asset://paper/'
assert.ok(url.startsWith(prefix), 'packaged preload returned an unexpected asset URL')
const payload = url.slice(prefix.length)
assert.match(payload, /^[A-Za-z0-9_-]+$/, 'asset payload is not URL-safe Base64')
assert.deepEqual(
  JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
  request,
  'asset payload did not preserve the request'
)
assert.deepEqual(encodings, ['base64'], 'packaged preload used a sandbox-incompatible encoding')

console.log('Packaged preload sandbox regression passed.')
