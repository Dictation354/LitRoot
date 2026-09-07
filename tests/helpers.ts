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
  if (query.includes('ambiguous')) return { schema_version: 2, index, attempt: 1, record_status: 'failed', error: { status: 'ambiguous', candidates: [{ doi: '10.5555/candidate', title: 'Candidate paper' }] }, acceptance: { overall: 'action_required' }, completion_order: completionOrder }
  if (query.includes('auth')) return { schema_version: 2, index, attempt: 1, record_status: 'failed', source: 'fakepaywall', error: { status: 'no_access', reason: 'Authentication required' }, acceptance: { overall: 'action_required' }, completion_order: completionOrder }
  if (query.includes('failed') || (query.includes('retry') && !args.includes('--overwrite'))) return { schema_version: 2, index, attempt: 1, record_status: 'failed', error: { status: 'error', code: 'network_error', reason: 'Fake network failure' }, acceptance: { overall: 'failed' }, completion_order: completionOrder }
  const kind = query.includes('limited') ? 'abstract_only' : 'fulltext'
  const raw = markdown(query, kind)
  const filename = query.includes('generated-name')
    ? \`FetchBot_2025_\${'A'.repeat(165)}.md\`
    : \`FetchBot_2025_Fetched_paper_\${index}.md\`
  const output = join(outputDir, filename)
  await writeFile(output, raw)
  const doi = raw.match(/doi: "([^"]+)/)?.[1] || null
  return { schema_version: 2, index, attempt: 1, record_status: 'completed', doi, output_artifacts: [{ kind: 'primary_markdown', path: output, sha256: hash(raw) }], acceptance: { overall: kind === 'fulltext' ? 'complete' : 'limited', content: { status: kind } }, completion_order: completionOrder }
}

if (args[0] === '--version') { console.log('paper-fetch 6.1.5-fake'); process.exit(0) }
if (args[0] !== 'fetch') process.exit(2)
if (args.includes('--help')) { console.log('--progress auto|text|jsonl|none --control-stdin'); process.exit(0) }
if (args.includes('--run-manifest') || args.includes('--resume')) {
  console.error('paper-fetch: error: unrecognized arguments: --run-manifest/--resume')
  process.exit(2)
}
if (process.env.PAPER_FETCH_TEST_FAILURE) {
  console.error(process.env.PAPER_FETCH_TEST_FAILURE)
  process.exit(2)
}
const outputDir = value('--output-dir')
await mkdir(outputDir, { recursive: true })
const queries = value('--query-file')
  ? (await readFile(value('--query-file'), 'utf8')).split(/\\r?\\n/).filter(Boolean)
  : [value('--query')]
const runId = 'fake-' + Date.now()
const cancelled = new Set()
const finished = new Set()
const event = (type, index, data = {}) => {
  if (value('--progress') !== 'jsonl') return
  process.stderr.write(JSON.stringify({ paper_fetch_progress: true, protocol_version: 1, run_id: runId, type, index, ...data }) + '\\n')
}
let control = ''
if (args.includes('--control-stdin')) {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    control += chunk
    let end
    while ((end = control.indexOf('\\n')) !== -1) {
      const line = control.slice(0, end)
      control = control.slice(end + 1)
      const command = JSON.parse(line)
      if (command.run_id !== runId) continue
      const targets = command.index === null ? queries.map((_, position) => position + 1) : [command.index]
      for (const index of targets) {
        if (!finished.has(index)) cancelled.add(index)
        event('cancel_response', index, { status: finished.has(index) ? 'already_finished' : 'cancelling' })
      }
    }
  })
  process.stdin.on('end', () => queries.forEach((_, position) => { if (!finished.has(position + 1)) cancelled.add(position + 1) }))
}
event('run_started', 0, { total: queries.length })
if (queries.some((query) => query.includes('protocol noise'))) {
  process.stderr.write('ordinary diagnostic\\n' + JSON.stringify({ status: 'error', index: 1 }) + '\\n')
  event('terminal', 1, { run_id: 'old-run', record: { index: 1, run_id: 'old-run', record_status: 'aborted' } })
  const partial = JSON.stringify({ paper_fetch_progress: true, protocol_version: 1, run_id: runId, type: 'assets', index: 1, scope: 'fragmented', counts: [{ kind: 'formula', completed: 2, total: null, failed: 0 }] })
  process.stderr.write(partial.slice(0, 45))
  await new Promise((resolve) => setTimeout(resolve, 30))
  process.stderr.write(partial.slice(45) + '\\n' + JSON.stringify({ paper_fetch_progress: true, protocol_version: 1, run_id: runId, type: 'stage', index: 1, stage: 'assets' }) + '\\n')
  await new Promise((resolve) => setTimeout(resolve, 30))
}

for (let index = 1; index <= queries.length; index += 1) event('stage', index, { stage: 'queued' })
const results = []
for (let position = queries.length - 1; position >= 0; position -= 1) {
  const index = position + 1
  const query = queries[position]
  event('stage', index, { stage: 'identity' })
  event('stage', index, { stage: 'fetching' })
  event('stage', index, { stage: 'assets' })
  event('assets', index, { scope: 'fake-assets', counts: [{ kind: 'formula', completed: 1, total: 3, failed: 0 }] })
  if (query.includes('slow')) {
    for (let step = 0; step < 150 && !cancelled.has(index); step += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const result = cancelled.has(index)
    ? { index, record_status: 'aborted', error: { status: 'aborted', code: 'request_cancelled', reason: 'Cancelled by control' } }
    : await record(query, index, outputDir, queries.length - position)
  result.run_id = runId
  results.push(result)
  finished.add(index)
  event('terminal', index, { record: result })
  if (query.includes('protocol noise')) event('terminal', index, { record: result })
}
if (value('--query-file')) {
  const jsonl = value('--batch-results')
  if (jsonl) await writeFile(jsonl, results.map((item) => JSON.stringify(item)).join('\\n') + '\\n')
} else {
  const result = results[0]
  const output = value('--output')
  const artifact = result.output_artifacts?.[0]
  if (output && artifact && artifact.path !== output) {
    const raw = await readFile(artifact.path)
    await writeFile(output, raw)
    artifact.path = output
    artifact.sha256 = hash(raw)
  }
  const manifest = value('--manifest')
  if (manifest) await writeFile(manifest, JSON.stringify(result))
  console.log(JSON.stringify(result))
}
if (results.some((item) => item.record_status !== 'completed')) process.exitCode = 1
process.stdin.pause()

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
