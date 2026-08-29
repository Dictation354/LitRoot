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
