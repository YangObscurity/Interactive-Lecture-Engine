import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateEnvExample } from '../src/config/schema.js'

const DEFAULT_ENV_EXAMPLE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../.env.example',
)

export interface ConfigCliOptions {
  targetPath?: string
  log?: (msg: string) => void
  error?: (msg: string) => void
}

function summarizeDiff(expected: string, actual: string): string[] {
  const notes: string[] = []
  if (actual.includes('\r\n') && actual.replace(/\r\n/g, '\n') === expected) {
    notes.push('Line ending mismatch: expected LF (\\n), found CRLF (\\r\\n).')
    return notes
  }

  const expLines = expected.split('\n')
  const actLines = actual.split(/\r?\n/)
  const maxLen = Math.max(expLines.length, actLines.length)
  let shown = 0

  for (let i = 0; i < maxLen; i++) {
    if (expLines[i] !== actLines[i]) {
      notes.push(
        `Line ${i + 1}: expected ${JSON.stringify(expLines[i] ?? '<EOF>')}, got ${JSON.stringify(actLines[i] ?? '<EOF>')}`,
      )
      shown++
      if (shown >= 5) {
        notes.push('... (additional differing lines omitted)')
        break
      }
    }
  }

  return notes
}

export function runConfigCli(
  args: string[] = process.argv.slice(2),
  options: ConfigCliOptions = {},
): number {
  const targetPath = options.targetPath ?? DEFAULT_ENV_EXAMPLE_PATH
  const log = options.log ?? ((msg: string) => console.log(msg))
  const error = options.error ?? ((msg: string) => console.error(msg))

  const isCheck = args.includes('--check') || args.includes('check')
  const expected = generateEnvExample()

  if (isCheck) {
    if (!existsSync(targetPath)) {
      error(`Missing ${targetPath}. Run "npm run config:gen" to generate it.`)
      return 1
    }

    const actual = readFileSync(targetPath, 'utf8')
    if (actual !== expected) {
      error(`Drift detected in ${targetPath}:`)
      for (const line of summarizeDiff(expected, actual)) {
        error(`  ${line}`)
      }
      error('Run "npm run config:gen" to regenerate .env.example.')
      return 1
    }

    log(`config:check passed: ${targetPath} is up to date.`)
    return 0
  }

  writeFileSync(targetPath, expected, 'utf8')
  log(`Generated ${targetPath}`)
  return 0
}

const isMain =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const code = runConfigCli()
  if (code !== 0) {
    process.exit(code)
  }
}
