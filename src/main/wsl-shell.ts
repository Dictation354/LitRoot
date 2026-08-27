const WSL_LOGIN_SHELL = '/bin/bash'
const WSL_LOGIN_COMMAND = 'exec "$@"'
const WSL_LOGIN_ARGV0 = 'litroot'

export function wslLoginShellArgs(distribution: string, args: readonly string[]): string[] {
  if (!distribution.trim()) throw new Error('WSL distribution is required.')
  if (args.length === 0) throw new Error('WSL command is required.')
  return [
    '-d',
    distribution,
    '--exec',
    WSL_LOGIN_SHELL,
    '-lic',
    WSL_LOGIN_COMMAND,
    WSL_LOGIN_ARGV0,
    ...args
  ]
}

export function cleanWslOutput(value: string): string {
  return value.replaceAll('\0', '').replace(/\r/g, '').trim()
}

export function lastOutputLine(value: string): string | null {
  const lines = cleanWslOutput(value)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.at(-1) ?? null
}

export function nodeVersionFromOutput(value: string): string | null {
  const lines = cleanWslOutput(value).split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? ''
    if (/^v?\d+\.\d+\.\d+(?:[-+][^\s]+)?$/.test(line)) return line
  }
  return null
}

export function supportedNode(version: string | null): boolean {
  if (!version) return false
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  return Boolean(match && Number(match[1]) === 24 && (
    Number(match[2]) > 15 || (Number(match[2]) === 15 && Number(match[3]) >= 0)
  ))
}
