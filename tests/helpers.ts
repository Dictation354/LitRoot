import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function paperMarkdown(options: {
  title?: string
  doi?: string
  year?: number
  contentKind?: 'fulltext' | 'abstract_only' | 'metadata_only'
  body?: string
  url?: string
} = {}): string {
  const title = options.title ?? 'A LitRoot test paper'
  const contentKind = options.contentKind ?? 'fulltext'
  return `---
title: ${JSON.stringify(title)}
authors:
  - Ada Researcher
journal: Journal of Local Tests
year: ${options.year ?? 2025}
doi: ${JSON.stringify(options.doi ?? '10.4242/litroot.test')}
url: ${JSON.stringify(options.url ?? 'https://example.test/papers/litroot')}
source: test_provider
has_fulltext: ${contentKind === 'fulltext' ? 'true' : 'false'}
content_kind: ${contentKind}
keywords:
  - local first
---

# ${title}

## Abstract

An auditable abstract for LitRoot.

## Results

${options.body ?? 'Full text result with enough searchable detail for project-scoped indexing.'}
`
}

export async function createFakePaperFetch(directory: string): Promise<string> {
  const path = join(directory, 'paper-fetch-fake.mjs')
  const script = `#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const args = process.argv.slice(2)
if (process.env.PAPER_FETCH_ARGS_LOG) await writeFile(process.env.PAPER_FETCH_ARGS_LOG, JSON.stringify(args))
const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null }
const hash = (data) => createHash('sha256').update(data).digest('hex')
const markdown = (query, kind = 'fulltext') => {
  const doi = query.match(/10\\.\\d{4,9}\\/\\S+/)?.[0]?.toLowerCase().replace(/[.,;]+$/, '') || '10.5555/' + hash(query).slice(0, 12)
  return \`---
title: "Fetched \${query.replaceAll('"', '')}"
authors: ["Fetch Bot"]
doi: "\${doi}"
url: "https://example.test/\${hash(query).slice(0, 8)}"
source: fake_provider
has_fulltext: \${kind === 'fulltext' && !query.includes('inconsistent')}
content_kind: \${kind}
---

# Fetched \${query}

## Abstract

Fake abstract.

## Body

\${kind === 'fulltext' ? 'Complete fake full text body.' : 'Only an abstract is available.'}

\${query.includes('missing asset') ? '![Missing figure](assets/missing.png)' : ''}
\`
}
const record = async (query, index, outputDir, completionOrder) => {
  if (query.includes('ambiguous')) return { index, attempt: 1, status: 'ambiguous', candidates: [{ doi: '10.5555/candidate', title: 'Candidate paper' }], acceptance: { overall: 'action_required' }, completion_order: completionOrder }
  if (query.includes('auth')) return { index, attempt: 1, status: 'no_access', provider: 'fakepaywall', reason: 'Authentication required', acceptance: { overall: 'action_required' }, completion_order: completionOrder }
  if (query.includes('failed')) return { index, attempt: 1, status: 'error', error: { code: 'network_error', reason: 'Fake network failure' }, acceptance: { overall: 'failed' }, completion_order: completionOrder }
  const kind = query.includes('limited') ? 'abstract_only' : 'fulltext'
  const raw = markdown(query, kind)
  const output = join(outputDir, \`paper-\${index}.md\`)
  await writeFile(output, raw)
  const doi = raw.match(/doi: "([^"]+)/)?.[1] || null
  return { index, attempt: 1, status: 'ok', doi, output_path: output, output_sha256: hash(raw), content_kind: kind, acceptance: { overall: kind === 'fulltext' ? 'complete' : 'limited', content: { content_kind: kind } }, completion_order: completionOrder }
}

if (args[0] === '--version') { console.log('paper-fetch 2.0.0-fake'); process.exit(0) }
if (args[0] === 'manifest' && args[1] === 'audit') { console.log(JSON.stringify({ status: 'reusable' })); process.exit(0) }
if (args[0] !== 'fetch') process.exit(2)
const outputDir = value('--output-dir')
await mkdir(outputDir, { recursive: true })
if (value('--query-file')) {
  const queries = (await readFile(value('--query-file'), 'utf8')).split(/\\r?\\n/).filter(Boolean)
  const results = []
  for (let position = queries.length - 1; position >= 0; position -= 1) results.push(await record(queries[position], position + 1, outputDir, queries.length - position))
  const jsonl = value('--batch-results')
  if (jsonl) await writeFile(jsonl, results.map((item) => JSON.stringify(item)).join('\\n') + '\\n')
  const manifest = value('--run-manifest') || value('--resume')
  if (manifest) await writeFile(manifest, JSON.stringify({ schema_version: 2, results }))
  if (queries.some((query) => query.includes('slow'))) await new Promise((resolve) => setTimeout(resolve, 3000))
} else {
  const query = value('--query')
  if (query.includes('slow')) await new Promise((resolve) => setTimeout(resolve, 3000))
  const output = value('--output')
  const result = await record(query, 1, outputDir, 1)
  if (result.output_path && result.output_path !== output) {
    const raw = await readFile(result.output_path)
    await writeFile(output, raw)
    result.output_path = output
    result.output_sha256 = hash(raw)
  }
  const manifest = value('--manifest')
  if (manifest) await writeFile(manifest, JSON.stringify(result))
  console.log(JSON.stringify(result))
}
`
  await mkdir(directory, { recursive: true })
  await writeFile(path, script, 'utf8')
  await chmod(path, 0o755)
  return path
}

export async function writePaper(projectPath: string, name: string, content: string): Promise<string> {
  const papers = join(projectPath, 'papers')
  await mkdir(papers, { recursive: true })
  const path = join(papers, name)
  await writeFile(path, content, 'utf8')
  return path
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeout = 8_000
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for condition.')
}
