// Replay captured upstream records; only output locations and batch identity are rebound.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
if (args[0] === '--version') {
  console.log('paper-fetch 7.0.1')
} else if (args.includes('--help')) {
  console.log(args[0] === 'auth'
    ? 'positional arguments: {wiley,science}'
    : '--progress {auto,text,jsonl,none} --control-stdin')
} else {
  const captures = JSON.parse(await readFile(new URL('./records.json', import.meta.url), 'utf8'))
  const batch = args.includes('--query-file')
  const queries = batch ? (await readFile(value('--query-file'), 'utf8')).trim().split('\n') : [value('--query')]
  const output = value('--output-dir')
  await mkdir(output, { recursive: true })
  const runId = 'fixture-run'
  const event = (type, index, fields) => process.stderr.write(`${JSON.stringify({
    paper_fetch_progress: true, protocol_version: 1, run_id: runId, type, index, ...fields
  })}\n`)
  event('run_started', 0, { total: queries.length })
  const results = []
  for (const [position, query] of queries.entries()) {
    const record = structuredClone(captures[query])
    record.index = position + 1
    record.run_id = runId
    for (const artifact of record.output_artifacts) {
      artifact.path = join(output, `${query}.md`)
      await writeFile(artifact.path, await readFile(new URL(`./${query}.md`, import.meta.url)))
    }
    results.push(record)
    event('terminal', record.index, { record })
  }
  await writeFile(value(batch ? '--batch-results' : '--manifest'), batch
    ? results.map((record) => JSON.stringify(record)).join('\n') + '\n'
    : JSON.stringify(results[0]))
}
