import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'

const appArchive = process.argv[2]
assert(appArchive && isAbsolute(appArchive), 'Expected an absolute path to resources/app.asar.')

const packagedRequire = createRequire(join(appArchive, 'package.json'))
const nodePty = packagedRequire('node-pty')
const command = process.env.ComSpec
assert(command && isAbsolute(command), 'The Windows ComSpec environment variable is required.')

const sentinel = `PAPERRELAY_WINDOWS_PTY_${Date.now()}`
const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry) => entry[1] !== undefined)
)

await new Promise((resolve, reject) => {
  let output = ''
  let stopRequested = false
  const terminal = nodePty.spawn(
    command,
    ['/d', '/s', '/c', `echo ${sentinel} & ping -n 30 127.0.0.1 >nul`],
    {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: environment
    }
  )
  const timeout = setTimeout(() => {
    try {
      terminal.kill()
    } catch {
      // Preserve the original timeout failure.
    }
    reject(new Error('The packaged Windows PTY did not start and stop within 15 seconds.'))
  }, 15_000)

  terminal.onData((data) => {
    output += data
    if (stopRequested || !output.includes(sentinel)) return
    stopRequested = true
    try {
      terminal.kill()
    } catch (error) {
      clearTimeout(timeout)
      reject(error)
    }
  })
  terminal.onExit(() => {
    clearTimeout(timeout)
    try {
      assert(stopRequested, 'The packaged PTY exited before producing the smoke-test sentinel.')
      assert(output.includes(sentinel), 'The packaged PTY output was incomplete.')
      resolve()
    } catch (error) {
      reject(error)
    }
  })
})

console.log('Packaged Windows node-pty runtime started, produced output, and stopped cleanly.')
