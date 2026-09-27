import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { diagnoseEnvironment, paperFetchAuthCommand, requirePaperFetchProgress, supportedPaperFetchVersion } from '../../src/service/diagnostics.js'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

it.each([
  ['7.0.0', false], ['7.0.1', true], ['7.0.10', true], ['7.1.0', true], ['8.0.0', true],
  ['6.99.99', false], ['7.0.1-rc.1', false], ['7.0.1+build', false], ['7.01.1', false], ['garbage', false]
])('compares formal release %s numerically', (version, accepted) => {
  expect(supportedPaperFetchVersion(`paper-fetch ${version}`)).toBe(accepted)
})

it.each(['--progress auto|text --control-stdin', '--progress jsonl', '--control-stdin', ''])('rejects missing capability: %s', async (help) => {
  const directory = await mkdtemp(join(tmpdir(), 'litroot-diagnostics-'))
  directories.push(directory)
  const file = join(directory, 'cli.mjs')
  await writeFile(file, `console.log(process.argv.includes('--version') ? 'paper-fetch 7.0.1' : ${JSON.stringify(help)})`)
  const command = { executable: process.execPath, prefixArgs: [file] }
  await expect(requirePaperFetchProgress(command)).rejects.toMatchObject({ code: 'paper_fetch_upgrade_required' })
  vi.stubEnv('PAPER_FETCH_BIN', process.execPath)
  vi.stubEnv('PAPER_FETCH_PREFIX_ARGS', JSON.stringify([file]))
  expect((await diagnoseEnvironment()).checks.find((check) => check.name === 'paper-fetch')?.ok).toBe(false)
})

it('uses command environment for version, protocol and advisory auth lookup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'litroot diagnostics '))
  directories.push(directory)
  const file = join(directory, 'cli.mjs')
  await writeFile(file, `
    if (process.env.PAPER_FETCH_ENV_FILE !== 'installer config') process.exit(2)
    console.log(process.argv.includes('--version') ? 'paper-fetch 7.0.1'
      : process.argv.includes('auth') ? 'positional arguments: {wiley,tandf}'
      : '--progress {jsonl,text} --control-stdin')
  `)
  vi.stubEnv('PAPER_FETCH_ENV_FILE', '')
  const command = { executable: process.execPath, prefixArgs: [file], envDefaults: { PAPER_FETCH_ENV_FILE: 'installer config' } }
  await expect(requirePaperFetchProgress(command)).resolves.toBeUndefined()
  await expect(paperFetchAuthCommand(command, 'wiley')).resolves.toBe('paper-fetch auth wiley')
  await expect(paperFetchAuthCommand(command, 'wiley_browser')).resolves.toBeNull()
  await expect(paperFetchAuthCommand(command, 'wiley; echo hi')).resolves.toBeNull()
  await writeFile(file, 'process.exit(1)')
  await expect(paperFetchAuthCommand(command, 'wiley')).resolves.toBeNull()
})
