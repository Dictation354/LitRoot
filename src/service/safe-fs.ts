import { constants } from 'node:fs'
import { mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const child = relative(resolve(rootPath), resolve(candidatePath))
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

export async function canonicalDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('项目路径必须是 WSL 绝对路径。')
  const canonical = await realpath(resolve(path))
  if (!(await stat(canonical)).isDirectory()) throw new Error('项目路径不是目录。')
  return canonical
}

export async function canonicalFileInside(
  rootPath: string,
  candidatePath: string
): Promise<string | null> {
  try {
    const canonicalRoot = await realpath(rootPath)
    const canonical = await realpath(candidatePath)
    if (!isPathInside(canonicalRoot, canonical)) return null
    return (await stat(canonical)).isFile() ? canonical : null
  } catch {
    return null
  }
}

export async function atomicWriteFile(path: string, content: string | Uint8Array): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const temporaryPath = resolve(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    const file = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try {
      await file.writeFile(content)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  try {
    const directoryHandle = await open(directory, constants.O_RDONLY)
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch {
    // Some filesystems do not permit fsync on a directory; the file rename is still atomic.
  }
}

export function portableRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '')
}
