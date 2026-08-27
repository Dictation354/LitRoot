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
const excludedTrees = ['docs', 'src', 'tests', 'scripts']

if (packageJson.name !== 'litroot' || packageJson.private !== true) failures.push('package.json must describe the private litroot application')
if (packageJson.main !== './out/main/index.js') failures.push('package.json main must point at the production main bundle')
if (config.appId !== 'io.litroot.desktop' || config.productName !== 'LitRoot') failures.push('desktop identity must be LitRoot')
if (config.directories?.output !== 'release') failures.push('packaged artifacts must be written under release/')
if (!files.includes('out/**') || !files.includes('package.json')) failures.push('package files must use an explicit out/package allowlist')
for (const tree of excludedTrees) {
  if (!files.includes(`!${tree}/**`)) failures.push(`package files must explicitly exclude ${tree}/`)
}
if (!resources.some((entry) => entry?.to === 'service/litroot-service.cjs')) {
  failures.push('the single-file WSL service must be an explicit external resource')
}
const windowsTargets = Array.isArray(config.win?.target) ? config.win.target : []
if (!windowsTargets.some((entry) => entry?.target === 'nsis' && entry.arch?.includes('x64'))) {
  failures.push('the Windows package must explicitly target x64 NSIS')
}
if (config.nsis?.perMachine !== false || config.nsis?.packElevateHelper !== false) {
  failures.push('the unsigned MVP installer must stay per-user and omit the unused elevation helper')
}
if (config.win?.icon !== 'resources/litroot-app-icon.png') failures.push('the Windows executable must use the LitRoot icon')
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
  console.log('LitRoot package boundary is explicit and includes only the desktop bundles and WSL service.')
}
