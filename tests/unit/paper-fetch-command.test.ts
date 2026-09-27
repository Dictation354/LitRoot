import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  normalizePaperFetchCommand,
  paperFetchCommandFromEnvironment
} from '../../src/service/paper-fetch-command.js'

afterEach(() => vi.unstubAllEnvs())

describe('paper-fetch command descriptor', () => {
  it('preserves a direct executable used by existing tests and WSL', () => {
    expect(normalizePaperFetchCommand('/opt/paper-fetch')).toEqual({
      executable: '/opt/paper-fetch',
      prefixArgs: []
    })
  })

  it('parses the fixed native prefix from the service environment', () => {
    vi.stubEnv('PAPER_FETCH_BIN', 'C:\\PaperFetchSkill\\runtime\\python.exe')
    vi.stubEnv('PAPER_FETCH_PREFIX_ARGS', '["-X","utf8","-m","paper_fetch.cli"]')
    expect(paperFetchCommandFromEnvironment()).toEqual({
      executable: 'C:\\PaperFetchSkill\\runtime\\python.exe',
      prefixArgs: ['-X', 'utf8', '-m', 'paper_fetch.cli']
    })
  })

  it('rejects malformed prefix arguments', () => {
    vi.stubEnv('PAPER_FETCH_PREFIX_ARGS', '["ok","bad\\narg"]')
    expect(() => paperFetchCommandFromEnvironment()).toThrow('bounded JSON string array')
  })
})

it('applies installer defaults only when an inherited value is empty', async () => {
  const { paperFetchEnvironment } = await import('../../src/service/paper-fetch-command.js')
  const command = { executable: 'python.exe', prefixArgs: [], envDefaults: { PAPER_FETCH_ENV_FILE: 'C:\\Paper Fetch\\offline.env' } }
  expect(paperFetchEnvironment(command, {})).toEqual(command.envDefaults)
  expect(paperFetchEnvironment(command, { PAPER_FETCH_ENV_FILE: '' })).toEqual(command.envDefaults)
  expect(paperFetchEnvironment(command, { PAPER_FETCH_ENV_FILE: 'custom.env', OTHER: 'kept' }))
    .toEqual({ PAPER_FETCH_ENV_FILE: 'custom.env', OTHER: 'kept' })
  expect(paperFetchEnvironment({ executable: 'paper-fetch.exe', prefixArgs: [] }, {})).toEqual({})
})
