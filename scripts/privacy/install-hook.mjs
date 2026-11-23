#!/usr/bin/env node
/**
 * scripts/privacy/install-hook.mjs — install the privacy gate as the engine repository's pre-commit hook (S3).
 *
 * Writes <git common dir>/hooks/pre-commit (or core.hooksPath) that runs `node scripts/privacy/scan.mjs --staged`.
 * An existing, different pre-commit hook is kept as pre-commit.local and runs first. Install it only in the
 * open-source engine repository: in a repository that also tracks content/ every content commit would be refused.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

export const HOOK = `#!/bin/sh
# installed by scripts/privacy/install-hook.mjs: refuse commits that would put personal content into the engine
here="$(dirname "$0")"
if [ -x "$here/pre-commit.local" ]; then "$here/pre-commit.local" "$@" || exit $?; fi
root="$(git rev-parse --show-toplevel)"
exec node "$root/scripts/privacy/scan.mjs" --staged
`

function main() {
  if (fs.existsSync(path.join(repo, 'content')) && git(['ls-files', 'content']).length > 0) {
    console.error('[privacy-hook] this repository tracks content/: install the hook only in the engine repository')
    process.exit(3)
  }
  let hooksDir = ''
  try {
    hooksDir = git(['config', '--get', 'core.hooksPath'])
  } catch {
    hooksDir = ''
  }
  hooksDir = hooksDir ? path.resolve(repo, hooksDir) : path.resolve(repo, git(['rev-parse', '--git-common-dir']), 'hooks')
  fs.mkdirSync(hooksDir, { recursive: true })
  const target = path.join(hooksDir, 'pre-commit')
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== HOOK) {
    const local = path.join(hooksDir, 'pre-commit.local')
    if (fs.existsSync(local)) {
      console.error(`[privacy-hook] both ${target} and ${local} exist: merge them by hand`)
      process.exit(3)
    }
    fs.renameSync(target, local)
    console.log(`[privacy-hook] kept the existing hook as ${local}`)
  }
  fs.writeFileSync(target, HOOK, { encoding: 'utf8', mode: 0o755 })
  console.log(`[privacy-hook] installed ${target}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
