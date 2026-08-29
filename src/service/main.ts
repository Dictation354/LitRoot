import { randomBytes } from 'node:crypto'
import { diagnoseEnvironment } from './diagnostics.js'
import { LitRootHttpServer } from './http-server.js'
import { ProjectRegistry } from './project-registry.js'

async function main(): Promise<void> {
  if (process.argv.includes('--diagnose')) {
    process.stdout.write(`${JSON.stringify(await diagnoseEnvironment())}\n`)
    return
  }

  const token = process.env.LITROOT_SESSION_TOKEN || randomBytes(32).toString('hex')
  if (!process.env.LITROOT_SESSION_TOKEN && !process.argv.includes('--allow-generated-token')) {
    throw new Error('LITROOT_SESSION_TOKEN is required.')
  }
  const registry = new ProjectRegistry()
  await registry.start()
  const server = new LitRootHttpServer(registry, token)
  const port = await server.start()
  process.stdout.write(`${JSON.stringify({ type: 'ready', apiVersion: 1, port })}\n`)

  let closing = false
  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    await server.close().catch(() => undefined)
    await registry.close().catch(() => undefined)
  }
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)) })
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)) })
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
