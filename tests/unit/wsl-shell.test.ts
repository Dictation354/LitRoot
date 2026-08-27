import { describe, expect, it } from 'vitest'
import {
  cleanWslOutput,
  lastOutputLine,
  nodeVersionFromOutput,
  supportedNode,
  wslLoginShellArgs
} from '../../src/main/wsl-shell.js'

describe('WSL login-shell launcher', () => {
  it('loads the login environment before replacing the shell with the requested command', () => {
    expect(wslLoginShellArgs('Ubuntu-D', ['node', '--version'])).toEqual([
      '-d',
      'Ubuntu-D',
      '--exec',
      '/bin/bash',
      '-lic',
      'exec "$@"',
      'litroot',
      'node',
      '--version'
    ])
  })

  it('keeps dynamic values in positional arguments instead of the shell program', () => {
    const servicePath = '/mnt/c/Research Papers/app; touch /tmp/not-executed.cjs'
    const args = wslLoginShellArgs('Ubuntu-D', [
      '/usr/bin/env',
      'LITROOT_SESSION_TOKEN=token with spaces',
      'node',
      servicePath
    ])

    expect(args[5]).toBe('exec "$@"')
    expect(args).toContain(servicePath)
    expect(args[5]).not.toContain(servicePath)
  })

  it('rejects missing launch targets', () => {
    expect(() => wslLoginShellArgs('', ['node'])).toThrow('WSL distribution is required.')
    expect(() => wslLoginShellArgs('Ubuntu-D', [])).toThrow('WSL command is required.')
  })
})

describe('WSL diagnostic output', () => {
  it('removes WSL encoding artifacts and selects the command output line', () => {
    expect(cleanWslOutput('\0warning\r\nvalue\r\n')).toBe('warning\nvalue')
    expect(lastOutputLine('shell startup message\npaper-fetch 5.3.1\n')).toBe('paper-fetch 5.3.1')
  })

  it('finds a Node version after noisy shell startup output', () => {
    expect(nodeVersionFromOutput('shell startup message\nv24.17.0\n')).toBe('v24.17.0')
    expect(nodeVersionFromOutput('node is unavailable')).toBeNull()
  })

  it('accepts only supported Node 24 releases', () => {
    expect(supportedNode('v24.15.0')).toBe(true)
    expect(supportedNode('v24.17.0')).toBe(true)
    expect(supportedNode('v24.14.9')).toBe(false)
    expect(supportedNode('v25.0.0')).toBe(false)
    expect(supportedNode(null)).toBe(false)
  })
})
