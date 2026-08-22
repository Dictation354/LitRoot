import { opendir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

const workspacePath = join(import.meta.dirname, '..')

async function collect(directory) {
  const files = []
  const entries = await opendir(directory)
  for await (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collect(path)))
    else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name))) files.push(path)
  }
  return files
}

const files = await collect(join(workspacePath, 'src'))
const testFiles = await collect(join(workspacePath, 'tests'))
const failures = []

for (const path of [...files, ...testFiles]) {
  const content = await readFile(path, 'utf8')
  const name = relative(workspacePath, path)
  if (/\b(?:describe|it|test)\.only\s*\(/.test(content)) failures.push(`${name}: focused test is not allowed`)
  if (/\/\/\s*@ts-ignore\b/.test(content)) failures.push(`${name}: @ts-ignore is not allowed`)
  if (name.startsWith('src/renderer/') && /(?:from\s+|import\s*\()['"](?:electron|node:)/.test(content)) {
    failures.push(`${name}: renderer code must not import Electron or Node built-ins`)
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Source hygiene passed for ${files.length + testFiles.length} TypeScript files.`)
}
