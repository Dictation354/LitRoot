import { lstat, mkdir, readFile, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type { FetchItem, FetchRun } from '../shared/contracts.js'
import { validatedImageFileInside } from './assets.js'
import { errorMessage } from './errors.js'
import { actionRequired, projectRecord, type ParsedTerminalRecord } from './fetch-record.js'
import { canonicalHttpUrl, doiFromInput, normalizeDoi, paperIdFor, sha256 } from './identity.js'
import { candidateAssetPath, parsePaperMarkdown } from './paper-markdown.js'
import type { ProjectDatabase } from './project-database.js'
import type { ProjectLayout } from './project-layout.js'
import {
  atomicWriteFile,
  canonicalDirectory,
  canonicalFileInside,
  isPathInside
} from './safe-fs.js'

function safeOutputBasename(path: string): string {
  const name = basename(path)
  const extension = extname(name)
  if (!['.md', '.markdown'].includes(extension.toLowerCase())) return 'article.md'
  const stem = name.slice(0, -extension.length)
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .slice(0, 180)
  return `${stem || 'article'}${extension}`
}

export class FetchAcceptance {
  constructor(
    private readonly layout: ProjectLayout,
    private readonly database: ProjectDatabase
  ) {}

  async accept(
    run: FetchRun,
    originalIndex: number,
    record: ParsedTerminalRecord,
    stagingRoot: string
  ): Promise<void> {
    const item = run.items[originalIndex - 1]
    if (!item) return
    const refreshPaperId = run.refreshPaperIds?.[originalIndex - 1] ?? run.refreshPaperId
    projectRecord(item, record)
    item.stage = 'terminal'

    if (record.status === 'cancelled') {
      item.state = 'cancelled'
      item.reason = record.reason ?? '任务已取消。'
      return
    }
    if (actionRequired(record)) {
      item.acceptance = 'action_required'
      item.state = 'action_required'
      if (record.provider && ['no_access', 'auth_required', 'challenge'].includes(record.status)) {
        item.reason = `${record.reason ?? '需要人工认证或合法访问权限。'}\n人工命令：paper-fetch auth ${record.provider}`
      }
      return
    }

    if (!record.acceptance && !['ok', 'success', 'complete'].includes(record.status)) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.reason = record.reason ?? `paper-fetch 返回状态 ${record.status}。`
      return
    }

    if (!record.outputPath) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.errorCode = item.errorCode ?? 'missing_markdown_output'
      item.reason = record.reason ?? '抓取未返回 Markdown 产物路径。'
      return
    }
    const output = await canonicalFileInside(stagingRoot, record.outputPath)
    if (!output) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.errorCode = 'output_path_outside_staging'
      item.reason = 'paper-fetch 返回的产物不在本次暂存区内。'
      return
    }

    let raw: string
    try {
      raw = await readFile(output, 'utf8')
    } catch (error) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.reason = `无法读取抓取产物：${errorMessage(error)}`
      return
    }
    const actualHash = sha256(raw)
    if (record.outputSha256 && record.outputSha256.toLowerCase() !== actualHash) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.errorCode = 'output_hash_mismatch'
      item.reason = '产物 SHA-256 与 manifest 不一致。'
      return
    }
    const parsed = parsePaperMarkdown(raw, safeOutputBasename(output))
    if (parsed.kind !== 'paper') {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.errorCode = 'untrusted_markdown'
      item.reason = parsed.reason
      return
    }
    const expectedDoi = record.canonicalDoi ?? doiFromInput(item.query)
    if (expectedDoi && parsed.paper.metadata.doi !== expectedDoi) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.errorCode = 'identity_mismatch'
      item.reason = 'Markdown DOI 与已解析身份不一致。'
      return
    }
    const expectedUrl = canonicalHttpUrl(record.canonicalUrl)
    if (
      !expectedDoi && expectedUrl && parsed.paper.metadata.url &&
      parsed.paper.metadata.url !== expectedUrl
    ) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.errorCode = 'identity_mismatch'
      item.reason = 'Markdown 来源 URL 与已解析身份不一致。'
      return
    }
    if (refreshPaperId) {
      const existing = this.database.reference(refreshPaperId)
      const existingDoi = normalizeDoi(existing?.doi)
      const existingUrl = canonicalHttpUrl(existing?.url)
      const identityMatches = Boolean(existing) && (
        existingDoi
          ? parsed.paper.metadata.doi === existingDoi
          : Boolean(existingUrl && parsed.paper.metadata.url === existingUrl)
      )
      if (!identityMatches) {
        item.acceptance = 'failed'
        item.state = 'failed'
        item.errorCode = 'refresh_identity_mismatch'
        item.reason = existingDoi || existingUrl
          ? '刷新产物与原论文身份不一致，旧全文已保留。'
          : '原论文没有可核验的 DOI 或来源 URL，无法安全刷新；旧全文已保留。'
        return
      }
    }
    if (!refreshPaperId && parsed.paper.metadata.doi) {
      const duplicate = this.database.findByDoi(parsed.paper.metadata.doi)
      if (duplicate) {
        item.canonicalDoi = parsed.paper.metadata.doi
        item.title = parsed.paper.metadata.title
        item.contentKind = parsed.paper.contentKind
        item.acceptance = 'action_required'
        item.state = 'action_required'
        item.existingPaperId = duplicate.id
        item.reason = '抓取解析出的 DOI 已存在于当前项目，未创建副本。'
        return
      }
      const prior = run.items.find((candidate) => (
        candidate.index !== item.index &&
        candidate.canonicalDoi === parsed.paper.metadata.doi &&
        candidate.outputPath !== null &&
        ['complete', 'degraded', 'limited'].includes(candidate.state)
      ))
      if (prior) {
        item.canonicalDoi = parsed.paper.metadata.doi
        item.title = parsed.paper.metadata.title
        item.contentKind = parsed.paper.contentKind
        item.acceptance = 'action_required'
        item.state = 'action_required'
        item.existingPaperId = paperIdFor(parsed.paper.metadata.doi, null, '')
        item.reason = `与第 ${prior.index} 条抓取结果解析为同一 DOI，未创建副本。`
        return
      }
    }

    const missingAssets = await this.missingAssets(output, parsed.paper.assetSources, stagingRoot)
    let overall = record.acceptance ?? (
      parsed.paper.hasFulltext ? 'complete' : 'limited'
    )
    if (!parsed.paper.hasFulltext && ['complete', 'degraded'].includes(overall)) {
      overall = 'limited'
    }
    if (overall === 'complete' && (missingAssets.length > 0 || parsed.paper.remoteAssetSources.length > 0)) {
      overall = 'degraded'
    }
    if (['failed', 'action_required'].includes(overall)) {
      item.acceptance = overall
      item.state = overall
      item.reason = record.reason ?? 'paper-fetch 验收未通过。'
      return
    }
    if (refreshPaperId && !parsed.paper.hasFulltext) {
      item.acceptance = 'limited'
      item.state = 'limited'
      item.contentKind = parsed.paper.contentKind
      item.errorCode = 'refresh_not_fulltext'
      item.reason = '刷新结果只有摘要或元数据，旧全文已保留。'
      return
    }
    if (
      refreshPaperId &&
      (missingAssets.length > 0 || parsed.paper.remoteAssetSources.length > 0)
    ) {
      item.acceptance = 'degraded'
      item.state = 'degraded'
      item.errorCode = 'refresh_asset_validation_failed'
      item.reason = `刷新有 ${missingAssets.length + parsed.paper.remoteAssetSources.length} 个正文资产未通过本地验收，旧全文已保留。`
      return
    }

    let finalPath: string
    try {
      const missingAssetSet = new Set(missingAssets)
      finalPath = await this.archiveOutput(
        item,
        output,
        raw,
        parsed.paper.assetSources.filter((source) => !missingAssetSet.has(source)),
        refreshPaperId
      )
    } catch (error) {
      item.acceptance = 'failed'
      item.state = 'failed'
      item.errorCode = 'archive_commit_failed'
      item.reason = `${errorMessage(error)}${refreshPaperId ? '；旧正文未替换，资产变更已进入回滚流程。' : ''}`
      return
    }
    item.outputPath = finalPath
    item.outputSha256 = actualHash
    item.canonicalDoi = parsed.paper.metadata.doi || record.canonicalDoi
    item.title = parsed.paper.metadata.title
    item.contentKind = parsed.paper.contentKind
    item.acceptance = overall
    item.state = overall
    const unavailableAssets = missingAssets.length + parsed.paper.remoteAssetSources.length
    item.reason = unavailableAssets > 0
      ? `正文已保存，但 ${unavailableAssets} 个图片资产缺失、越界或为远程资源，已阻止加载。`
      : record.reason
  }

  private async missingAssets(output: string, sources: string[], stagingRoot: string): Promise<string[]> {
    const missing: string[] = []
    for (const source of sources) {
      const candidate = candidateAssetPath(output, source)
      if (!candidate || !await validatedImageFileInside(stagingRoot, candidate)) missing.push(source)
    }
    return missing
  }

  private async archiveOutput(
    item: FetchItem,
    output: string,
    raw: string,
    assetSources: string[],
    refreshPaperId: string | null
  ): Promise<string> {
    if (refreshPaperId) {
      const target = this.database.reference(refreshPaperId)?.filePath
      if (!target) throw new Error('刷新目标不存在。')
      await this.replaceRefresh(output, target, raw, assetSources)
      return target
    }

    const parsed = parsePaperMarkdown(raw, safeOutputBasename(output))
    if (parsed.kind !== 'paper') throw new Error('暂存 Markdown 不是可信论文。')
    const provisionalRelative = `papers/${safeOutputBasename(output)}`
    const identityPaperId = paperIdFor(
      parsed.paper.metadata.doi || null,
      parsed.paper.metadata.url || item.canonicalUrl,
      provisionalRelative
    )
    const duplicate = parsed.paper.metadata.doi
      ? this.database.findByDoi(parsed.paper.metadata.doi)
      : null
    if (duplicate) {
      item.existingPaperId = duplicate.id
      item.reason = '同批或当前项目中的相同 DOI 已存在；本项映射到现有论文。'
      return duplicate.filePath || duplicate.relativePath
    }
    const archiveDirectory = parsed.paper.metadata.doi || parsed.paper.metadata.url || item.canonicalUrl
      ? identityPaperId
      : `paper-${sha256(item.query).slice(0, 16)}`
    const directory = join(this.layout.papers, archiveDirectory)
    await mkdir(directory, { recursive: true })
    if (!isPathInside(this.layout.root, await canonicalDirectory(directory))) {
      throw new Error('归档目录通过符号链接越出了项目。')
    }
    const target = join(directory, safeOutputBasename(output))
    await this.copyAssets(output, target, assetSources)
    await atomicWriteFile(target, raw)
    return target
  }

  private async copyAssets(sourceMarkdown: string, targetMarkdown: string, sources: string[]): Promise<void> {
    for (const source of sources) {
      const from = candidateAssetPath(sourceMarkdown, source)
      const to = candidateAssetPath(targetMarkdown, source)
      if (!from || !to || !isPathInside(this.layout.root, to)) {
        throw new Error(`资产路径不安全：${source}`)
      }
      const canonical = await validatedImageFileInside(this.filesRootFor(sourceMarkdown), from)
      if (!canonical) throw new Error(`资产不存在或越出暂存区：${source}`)
      await mkdir(dirname(to), { recursive: true })
      if (!isPathInside(this.layout.root, await canonicalDirectory(dirname(to)))) {
        throw new Error(`资产目标目录越出项目：${source}`)
      }
      const data = await readFile(canonical)
      await atomicWriteFile(to, data)
    }
  }

  private async replaceRefresh(
    sourceMarkdown: string,
    targetMarkdown: string,
    markdown: string,
    sources: string[]
  ): Promise<void> {
    const changes: Array<{ path: string; previous: Uint8Array | null }> = []
    try {
      for (const source of sources) {
        const from = candidateAssetPath(sourceMarkdown, source)
        const to = candidateAssetPath(targetMarkdown, source)
        if (!from || !to || !isPathInside(this.layout.root, to)) throw new Error(`资产路径不安全：${source}`)
        const canonicalSource = await validatedImageFileInside(this.filesRootFor(sourceMarkdown), from)
        if (!canonicalSource) throw new Error(`资产不存在或格式不安全：${source}`)
        await mkdir(dirname(to), { recursive: true })
        if (!isPathInside(this.layout.root, await canonicalDirectory(dirname(to)))) {
          throw new Error(`资产目标目录越出项目：${source}`)
        }
        const existing = await canonicalFileInside(this.layout.root, to)
        let previous: Uint8Array | null = null
        if (existing) {
          previous = await readFile(existing)
        } else {
          try {
            await lstat(to)
            throw new Error(`既有资产路径不是安全的项目内文件：${source}`)
          } catch (error) {
            if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
          }
        }
        changes.push({ path: to, previous })
        await atomicWriteFile(to, await readFile(canonicalSource))
      }
      await atomicWriteFile(targetMarkdown, markdown)
    } catch (error) {
      for (const change of changes.reverse()) {
        if (change.previous !== null) await atomicWriteFile(change.path, change.previous).catch(() => undefined)
        else await unlink(change.path).catch(() => undefined)
      }
      throw error
    }
  }

  private filesRootFor(markdownPath: string): string {
    const relativePath = relative(this.layout.temporary, markdownPath)
    const runDirectory = relativePath.split(/[\\/]/, 1)[0]
    return resolve(this.layout.temporary, runDirectory || '.')
  }
}
