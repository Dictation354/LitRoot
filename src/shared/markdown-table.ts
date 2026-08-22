export type MarkdownTableAlignment = 'left' | 'center' | 'right' | null

export interface MarkdownTable {
  headers: string[]
  alignments: MarkdownTableAlignment[]
  rows: string[][]
}

function splitMarkdownRow(line: string): string[] {
  let value = line.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1)

  const cells: string[] = []
  let cell = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? ''
    const next = value[index + 1]
    if (character === '\\' && (next === '|' || next === '\\')) {
      cell += next
      index += 1
      continue
    }
    if (character === '|') {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += character
  }
  cells.push(cell.trim())
  return cells
}

function alignment(cell: string): MarkdownTableAlignment | undefined {
  const marker = cell.replace(/\s+/g, '')
  if (!/^:?-{3,}:?$/.test(marker)) return undefined
  if (marker.startsWith(':') && marker.endsWith(':')) return 'center'
  if (marker.endsWith(':')) return 'right'
  if (marker.startsWith(':')) return 'left'
  return null
}

function normalizeRow(cells: string[], columns: number): string[] {
  return Array.from({ length: columns }, (_, index) => cells[index] ?? '')
}

export function parseMarkdownTable(block: string): MarkdownTable | null {
  const lines = block
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length < 2 || !lines[0]?.includes('|') || !lines[1]?.includes('-')) return null

  const headers = splitMarkdownRow(lines[0])
  const delimiter = splitMarkdownRow(lines[1])
  if (headers.length === 0 || delimiter.length !== headers.length) return null

  const alignments = delimiter.map(alignment)
  if (alignments.some((value) => value === undefined)) return null

  const rows = lines.slice(2).map((line) => normalizeRow(splitMarkdownRow(line), headers.length))
  return {
    headers,
    alignments: alignments as MarkdownTableAlignment[],
    rows
  }
}
