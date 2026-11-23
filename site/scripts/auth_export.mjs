#!/usr/bin/env node
/**
 * scripts/auth_export.mjs — CLI entry for `npm run auth:export [authelia|nginx]`.
 *
 * Reads `site/lecture.config.ts` (`access`, `i18n`), course groups (`groups-source.mts`), and
 * optional env overrides (`LECTURE_ACCESS_JSON`, `LECTURE_BUILD_GROUPS`) to emit gateway
 * access-control rules that match the built site's path prefixes and `/_access/<tier>/` slices.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveI18n } from '../docs/.vitepress/lecture-config.mts'
import { loadLectureConfig } from '../docs/.vitepress/content/config.mts'
import { LANG_CODES, localeKeyOf } from '../docs/.vitepress/i18n/langs.ts'
import { resolveGroups } from '../docs/.vitepress/groups-source.mts'
import {
  formatAutheliaYaml,
  formatNginxAuthSnippet,
  parseAuthExportArgs,
  resolveAuthPlan,
} from '../docs/.vitepress/access/authExport.ts'

export { parseAuthExportArgs }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SITE_DIR = path.resolve(__dirname, '..')

function usage() {
  return [
    'Usage: npm run auth:export [authelia|nginx] [options]',
    '',
    'Options:',
    '  --format authelia|nginx     Output format (default: authelia)',
    '  --domain <host>             Domain for the Authelia rules (REQUIRED for authelia: rules without domain are rejected)',
    '  --admin-groups <a,b>        Comma-separated gateway admin groups (default: admins,admin)',
    '  --factor one_factor|two_factor  Authentication level for non-public rules (default: two_factor)',
    '  --access-json <json>        Override lecture.config access block (or LECTURE_ACCESS_JSON)',
    '  --build-groups <ids>        Limit groups (or LECTURE_BUILD_GROUPS)',
    '  --out <path>                Write output to file instead of stdout',
    '  -h, --help                  Show this help',
  ].join('\n')
}

/**
 * Resolve the current site's access plan without polluting stdout (info logs go to stderr).
 */
export async function generateAuthExport(opts = {}, env = process.env) {
  const mergedEnv = { ...env }
  if (opts.accessJson !== undefined) mergedEnv.LECTURE_ACCESS_JSON = opts.accessJson
  if (opts.buildGroups !== undefined) mergedEnv.LECTURE_BUILD_GROUPS = opts.buildGroups

  // resolveGroups() prints `[groups] ...` via console.log; redirect to stderr so stdout stays valid YAML.
  const origLog = console.log
  console.log = (...args) => console.error(...args)
  let groups
  try {
    const resolved = await resolveGroups()
    groups = resolved.GROUPS
  } finally {
    console.log = origLog
  }

  const lectureConfig = loadLectureConfig()
  const i18n = resolveI18n(lectureConfig)
  const localeKeys = LANG_CODES.filter((l) => l !== i18n.root && i18n.locales.includes(l)).map(localeKeyOf)
  const plan = resolveAuthPlan(lectureConfig.access, groups, mergedEnv)
  const input = {
    plan,
    groups,
    localeKeys,
    ...(opts.adminGroups ? { adminGroups: opts.adminGroups } : {}),
    ...(opts.domain ? { domain: opts.domain } : {}),
    ...(opts.factor ? { factor: opts.factor } : {}),
  }

  if (opts.format === 'nginx') {
    const templatePath = path.resolve(SITE_DIR, '../server/deploy/nginx-locations.conf')
    const template = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf8') : undefined
    if (template === undefined) console.error(`[auth:export] ${templatePath} not found: printing a pointer instead of the API locations`)
    return formatNginxAuthSnippet(input, template)
  }
  return formatAutheliaYaml(input)
}

async function main() {
  let opts
  try {
    opts = parseAuthExportArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[auth:export] ${err instanceof Error ? err.message : String(err)}`)
    console.error(usage())
    process.exit(2)
  }

  if (opts.help) {
    console.log(usage())
    process.exit(0)
  }

  if (opts.format === 'authelia' && !opts.domain) {
    console.error('[auth:export] --domain <host> is required for the authelia format (Authelia rejects rules without a domain).')
    console.error('Example: npm run auth:export authelia -- --domain docs.example.com --admin-groups admins')
    process.exit(2)
  }

  const output = await generateAuthExport(opts)
  if (opts.outFile) {
    const abs = path.isAbsolute(opts.outFile) ? opts.outFile : path.resolve(SITE_DIR, opts.outFile)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, output, 'utf8')
    console.error(`[auth:export] wrote ${path.relative(SITE_DIR, abs)}`)
  } else {
    process.stdout.write(output)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[auth:export] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
