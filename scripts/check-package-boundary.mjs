import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'

const workspacePath = join(import.meta.dirname, '..')
const config = parse(await readFile(join(workspacePath, 'electron-builder.yml'), 'utf8'))
const packageJson = JSON.parse(await readFile(join(workspacePath, 'package.json'), 'utf8'))
const ignore = await readFile(join(workspacePath, '.gitignore'), 'utf8')
const failures = []

const files = Array.isArray(config.files) ? config.files : []
const resources = Array.isArray(config.extraResources) ? config.extraResources : []
const asarUnpack = Array.isArray(config.asarUnpack) ? config.asarUnpack : []
const excludedTrees = ['docs', 'local-research', 'src', 'tests', 'scripts']

if (packageJson.private !== true) failures.push('package.json must remain private')
if (packageJson.main !== './out/main/index.js') failures.push('package.json main must point at the production main bundle')
if (config.directories?.output !== 'release') failures.push('packaged artifacts must be written under release/')
if (!files.includes('out/**') || !files.includes('package.json')) failures.push('package files must use an explicit out/package allowlist')
for (const tree of excludedTrees) {
  if (!files.includes(`!${tree}/**`)) failures.push(`package files must explicitly exclude ${tree}/`)
}
if (!resources.some((entry) => entry?.to === 'relay/paperrelay-relay.cjs')) {
  failures.push('the relay bundle must be an explicit external resource')
}
if (!asarUnpack.includes('node_modules/node-pty/**')) {
  failures.push('node-pty and its Windows helper binaries must be unpacked from ASAR')
}
const windowsTargets = Array.isArray(config.win?.target) ? config.win.target : []
if (
  !windowsTargets.some(
    (entry) => entry?.target === 'nsis' && Array.isArray(entry.arch) && entry.arch.includes('x64')
  )
) {
  failures.push('the Windows package must explicitly target x64 NSIS')
}
if (config.win?.icon !== 'resources/paperrelay-app-icon.png') {
  failures.push('the Windows executable must use the PaperRelay icon')
}
for (const scriptName of ['package:win', 'package:win:dir']) {
  if (!String(packageJson.scripts?.[scriptName] ?? '').includes('electron-builder@26.15.6')) {
    failures.push(`${scriptName} must pin electron-builder 26.15.6`)
  }
}
for (const entry of resources) {
  const source = String(entry?.from ?? '')
  if (source.startsWith('/') || source.includes('..')) failures.push(`extra resource escapes the workspace: ${source}`)
}
for (const requiredIgnore of ['release/', '*.sqlite3', '*.p12', 'test-results/']) {
  if (!ignore.split(/\r?\n/).includes(requiredIgnore)) failures.push(`.gitignore is missing ${requiredIgnore}`)
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log('Package boundary configuration is explicit and excludes source corpora, tests, and credentials.')
}
