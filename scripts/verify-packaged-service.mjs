import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const inputs = process.argv.slice(2)
if (inputs[0] === '--') inputs.shift()
const [executableInput, serviceInput] = inputs
assert.ok(executableInput && serviceInput, 'usage: verify-packaged-service <executable> <service>')
const executable = resolve(executableInput)
const service = resolve(serviceInput)
const temporary = await mkdtemp(join(tmpdir(), 'litroot-packaged-service-'))
const token = randomBytes(32).toString('hex')
const child = spawn(executable, [service], {
  shell: false,
  windowsHide: true,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    LITROOT_SESSION_TOKEN: token,
    LITROOT_RUNTIME_LABEL: 'Packaged runtime test',
    LITROOT_REGISTRY_PATH: join(temporary, 'projects.json'),
    PAPER_FETCH_BIN: join(temporary, 'paper-fetch-unavailable'),
    PAPER_FETCH_PREFIX_ARGS: '[]'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => { stdout += chunk })
child.stderr.on('data', (chunk) => { stderr += chunk })

try {
  const port = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`service startup timed out: ${stderr}`)), 20_000)
    const inspect = () => {
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const value = JSON.parse(line)
          if (value?.type === 'ready' && Number.isInteger(value.port)) {
            clearTimeout(timer)
            resolveReady(value.port)
            return
          }
        } catch {
          // Wait for the structured ready line.
        }
      }
    }
    child.stdout.on('data', inspect)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`service exited before ready (${code}): ${stderr}`))
    })
  })
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, apiVersion: 1 })
  console.log('Packaged LitRoot service runtime passed.')
} finally {
  if (child.exitCode === null) child.kill('SIGTERM')
  await new Promise((resolveExit) => {
    if (child.exitCode !== null) resolveExit()
    else child.once('exit', resolveExit)
  })
  await rm(temporary, { recursive: true, force: true })
}
