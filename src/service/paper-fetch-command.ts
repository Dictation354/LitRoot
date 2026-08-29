export interface PaperFetchCommand {
  executable: string
  prefixArgs: string[]
}

export function paperFetchCommandFromEnvironment(): PaperFetchCommand {
  const executable = process.env.PAPER_FETCH_BIN || 'paper-fetch'
  const rawPrefix = process.env.PAPER_FETCH_PREFIX_ARGS
  if (!rawPrefix) return { executable, prefixArgs: [] }
  let value: unknown
  try {
    value = JSON.parse(rawPrefix)
  } catch {
    throw new Error('PAPER_FETCH_PREFIX_ARGS must be a JSON string array.')
  }
  if (
    !Array.isArray(value) || value.length > 20 ||
    value.some((item) => typeof item !== 'string' || item.length > 1_000 || /[\0\r\n]/.test(item))
  ) {
    throw new Error('PAPER_FETCH_PREFIX_ARGS must be a bounded JSON string array.')
  }
  return { executable, prefixArgs: value }
}

export function normalizePaperFetchCommand(
  command?: string | PaperFetchCommand
): PaperFetchCommand {
  if (typeof command === 'string') return { executable: command, prefixArgs: [] }
  return command ?? paperFetchCommandFromEnvironment()
}
