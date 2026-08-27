export interface BatchInputResult {
  inputs: string[]
  ignoredBlankLines: number
}

export function parseBatchInput(value: string, maximum = 50): BatchInputResult {
  const lines = value.replace(/\r\n?/g, '\n').split('\n')
  const inputs: string[] = []
  let ignoredBlankLines = 0
  for (const line of lines) {
    const normalized = line.trim().replace(/\s+/gu, ' ')
    if (!normalized) {
      ignoredBlankLines += 1
      continue
    }
    if (normalized.length > 4_000) throw new Error('每条输入最多 4,000 个字符。')
    inputs.push(normalized)
  }
  if (inputs.length === 0) throw new Error('请输入至少一条论文标识或引用。')
  if (inputs.length > maximum) throw new Error(`一次最多添加 ${maximum} 条。`)
  return { inputs, ignoredBlankLines }
}
