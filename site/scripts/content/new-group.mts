/**
 * scripts/content/new-group.mts — `npm run new:group -- --id G01 --dir g01 --title "..." [options]`.
 * Appends the group to groups.ts and writes lectures/<dir>/index.md (scaffold.mts newGroup).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { newGroup, ScaffoldError } from './scaffold.mts'

const USAGE = `usage: npm run new:group -- --id <ID> --dir <dir> --title <title>
  [--tagline <text>] [--summary <text>] [--accent #RRGGBB] [--tags "a,b"] [--category <name>] [--temp]
  [--title-en <text>] [--tagline-en <text>] [--summary-en <text>] [--category-en <name>]`

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      id: { type: 'string' },
      dir: { type: 'string' },
      title: { type: 'string' },
      tagline: { type: 'string' },
      summary: { type: 'string' },
      accent: { type: 'string' },
      tags: { type: 'string' },
      category: { type: 'string' },
      temp: { type: 'boolean' },
      'title-en': { type: 'string' },
      'tagline-en': { type: 'string' },
      'summary-en': { type: 'string' },
      'category-en': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  })
  if (values.help || !values.id || !values.dir || !values.title) {
    process.stdout.write(`${USAGE}\n`)
    if (!values.help) process.exit(2)
    return
  }
  const res = await newGroup({
    id: values.id,
    dir: values.dir,
    title: values.title,
    tagline: values.tagline,
    summary: values.summary,
    accent: values.accent,
    tags: values.tags ? values.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    category: values.category,
    temp: values.temp,
    titleEn: values['title-en'],
    taglineEn: values['tagline-en'],
    summaryEn: values['summary-en'],
    categoryEn: values['category-en'],
  })
  process.stdout.write(
    [`[new:group] added ${res.group.id} (${res.group.dir})`, ...res.files.map((f) => `  ~ ${f}`), 'Next: npm run new:lecture -- --group ' + res.group.id + ' --title "<title>"', ''].join('\n'),
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`[new:group] ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(err instanceof ScaffoldError ? err.exitCode : 1)
  })
}
