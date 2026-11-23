/**
 * scripts/content/new-lecture.mts — `npm run new:lecture -- --group G01 --title "..." [options]`.
 * Writes lectures/<dir>/Lxx.md in the lecture contract (scaffold.mts newLecture); `--title-en` adds the translation.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { newLecture, ScaffoldError } from './scaffold.mts'

const USAGE = `usage: npm run new:lecture -- --group <ID or dir> --title <title>
  [--n <number>] [--node <node id>] [--difficulty 1-5] [--minutes <n>] [--title-en <title>]`

function intOption(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n)) throw new ScaffoldError(`--${name} must be an integer`)
  return n
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      group: { type: 'string' },
      title: { type: 'string' },
      n: { type: 'string' },
      node: { type: 'string' },
      difficulty: { type: 'string' },
      minutes: { type: 'string' },
      'title-en': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  })
  if (values.help || !values.group || !values.title) {
    process.stdout.write(`${USAGE}\n`)
    if (!values.help) process.exit(2)
    return
  }
  const res = await newLecture({
    group: values.group,
    title: values.title,
    n: intOption(values.n, 'n'),
    node: values.node,
    difficulty: intOption(values.difficulty, 'difficulty'),
    minutes: intOption(values.minutes, 'minutes'),
    titleEn: values['title-en'],
  })
  process.stdout.write(
    [`[new:lecture] ${res.group.id} lecture ${res.n}`, ...res.files.map((f) => `  + ${f}`), 'Next: write the body, then npm run check:content', ''].join('\n'),
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`[new:lecture] ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(err instanceof ScaffoldError ? err.exitCode : 1)
  })
}
