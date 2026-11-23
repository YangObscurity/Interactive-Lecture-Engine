/**
 * scripts/content/init.mts — `npm run init`: create a new content folder from `templates/content/`.
 * Target: LECTURE_CONTENT_DIR when set, else <repo>/content. Refuses when the target already holds anything.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initContent, ScaffoldError } from './scaffold.mts'

function main(): void {
  const res = initContent()
  const out = [
    `[init] created ${res.root}`,
    ...res.files.map((f) => `  + ${f}`),
    ...res.dirs.map((d) => `  + ${d}/`),
    '',
    'Next:',
    '  1. fill "name" (zh and en) in site-texts.json — the build stops while it is empty',
    '  2. npm run new:group -- --id G01 --dir g01 --title "<course>"',
    '  3. npm run new:lecture -- --group G01 --title "<lecture title>"',
    '  4. npm run check:content && npm run doctor',
    `  5. keep the content folder in its own git repository: cd "${res.root}" && git init`,
    '',
  ]
  process.stdout.write(out.join('\n'))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    process.stderr.write(`[init] ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(err instanceof ScaffoldError ? err.exitCode : 1)
  }
}
