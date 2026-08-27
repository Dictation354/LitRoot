import { opendir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

const workspacePath = join(import.meta.dirname, '..')
const sourceDirectories = ['.github', 'docs', 'scripts', 'src', 'tests']
const rootFiles = [
  '.gitattributes',
  '.gitignore',
  '.node-version',
  '.npmrc',
  'README.md',
  'README.en.md',
  'electron-builder.yml',
  'electron.vite.config.ts',
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
  'vite.service.config.ts',
  'vitest.config.ts'
]
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.ts', '.tsx', '.yaml', '.yml'])

async function collect(directory) {
  const files = []
  const entries = await opendir(directory)
  for await (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collect(path)))
    else if (entry.isFile() && textExtensions.has(extname(entry.name))) files.push(path)
  }
  return files
}

const files = [
  ...rootFiles.map((file) => join(workspacePath, file)),
  ...(await Promise.all(sourceDirectories.map((directory) => collect(join(workspacePath, directory))))).flat()
]
const failures = []

for (const path of files.sort()) {
  const content = await readFile(path, 'utf8')
  const name = relative(workspacePath, path)
  if (content.includes('\r')) failures.push(`${name}: contains CR line endings`)
  if (content.length > 0 && !content.endsWith('\n')) failures.push(`${name}: missing final newline`)
  content.split('\n').forEach((line, index) => {
    if (/[\t ]+$/.test(line)) failures.push(`${name}:${index + 1}: trailing whitespace`)
  })
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(`Formatting hygiene passed for ${files.length} text files.`)
}
