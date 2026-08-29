import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const workspacePath = join(import.meta.dirname, '..')
const packageJson = JSON.parse(await readFile(join(workspacePath, 'package.json'), 'utf8'))
const result = spawnSync(
  'ISCC.exe',
  [`/DAppVersion=${packageJson.version}`, join(workspacePath, 'installer', 'windows.iss')],
  { cwd: workspacePath, stdio: 'inherit' }
)

if (result.error) {
  console.error('Inno Setup 6 ISCC.exe must be available on PATH.')
  process.exitCode = 1
} else {
  process.exitCode = result.status ?? 1
}
