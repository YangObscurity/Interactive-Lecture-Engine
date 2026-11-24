export type { AppConfig as EnvConfig } from './schema.js'

export class ConfigError extends Error {
  readonly invalidKeys: string[]

  constructor(message: string, invalidKeys: string[] = []) {
    super(message)
    this.name = 'ConfigError'
    this.invalidKeys = [...invalidKeys]
  }
}

/**
 * Parses .env file text into key-value pairs.
 * Rules:
 *  - strip optional leading UTF-8 BOM
 *  - handle both CRLF and LF line endings
 *  - ignore blank lines and # comments
 *  - strip optional 'export ' prefix
 *  - split on first '=', trim key and unquoted outer value
 *  - support single-line quoted values with optional trailing # comment (e.g. FOO="a" # note)
 *  - support multi-line quoted values until closing quote
 *  - throw ConfigError naming key (never leaking value) on unclosed quote at EOF
 *  - no backslash escapes (Windows paths stay as written)
 *  - for unquoted values, ' #' starts an inline comment
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!text) return out

  const cleaned = text.startsWith('\ufeff') ? text.slice(1) : text
  const lines = cleaned.split(/\r?\n/)

  let inMultiLineQuote = false
  let currentKey = ''
  let currentQuoteChar = ''
  let accumulatedValue = ''

  for (const rawLine of lines) {
    if (inMultiLineQuote) {
      const closeIdx = rawLine.indexOf(currentQuoteChar)
      if (closeIdx !== -1) {
        const trailing = rawLine.slice(closeIdx + 1)
        if (!/^\s*(?:#.*)?$/.test(trailing)) {
          throw new ConfigError(
            `Invalid .env syntax for key ${currentKey}: unexpected characters after closing quote`,
            [currentKey],
          )
        }
        accumulatedValue += '\n' + rawLine.slice(0, closeIdx)
        out[currentKey] = accumulatedValue
        inMultiLineQuote = false
        currentKey = ''
        currentQuoteChar = ''
        accumulatedValue = ''
      } else {
        accumulatedValue += '\n' + rawLine
      }
      continue
    }

    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    let line = trimmed
    if (line.startsWith('export ')) {
      line = line.slice(7).trimStart()
    }
    const eqIdx = line.indexOf('=')
    if (eqIdx === -1) continue

    const key = line.slice(0, eqIdx).trim()
    if (!key) continue

    const rawAfterEq = line.slice(eqIdx + 1)
    const trimmedAfterEq = rawAfterEq.trimStart()

    if (trimmedAfterEq.startsWith('"') || trimmedAfterEq.startsWith("'")) {
      const val = trimmedAfterEq.trim()
      const q = val[0]!
      const closeIdx = val.indexOf(q, 1)
      if (closeIdx !== -1) {
        const trailing = val.slice(closeIdx + 1)
        if (!/^\s*(?:#.*)?$/.test(trailing)) {
          throw new ConfigError(
            `Invalid .env syntax for key ${key}: unexpected characters after closing quote`,
            [key],
          )
        }
        out[key] = val.slice(1, closeIdx)
      } else {
        inMultiLineQuote = true
        currentKey = key
        currentQuoteChar = q
        accumulatedValue = val.slice(1)
      }
    } else {
      const commentMatch = /\s#/.exec(rawAfterEq)
      const val = (commentMatch ? rawAfterEq.slice(0, commentMatch.index) : rawAfterEq).trim()
      out[key] = val
    }
  }

  if (inMultiLineQuote) {
    throw new ConfigError(
      `Invalid .env syntax for key ${currentKey}: unclosed quote before end of file`,
      [currentKey],
    )
  }

  return out
}

/**
 * Formats a value so that parseEnv reads back the exact same string.
 * Plain when safe; otherwise wrapped in double quotes (or single quotes if value contains ").
 * No backslash escaping is used so Windows paths round-trip verbatim.
 */
export function formatEnvValue(value: string): string {
  if (value.includes('\r')) {
    throw new ConfigError(
      'Cannot safely serialize .env value containing carriage return (\\r); inject via environment variable instead',
    )
  }
  const needsQuotes =
    /\s#/.test(value) ||
    /^\s|\s$/.test(value) ||
    /^["']/.test(value) ||
    value.includes('\n')
  if (value === '' || !needsQuotes) return value
  if (!value.includes('"')) return `"${value}"`
  if (!value.includes("'") && !value.includes('\n')) {
    return `'${value}'`
  }
  throw new ConfigError(
    'Cannot safely serialize .env value containing both quote types (or multiline double quotes); inject via environment variable instead',
  )
}

/**
 * Updates .env text while preserving line endings (CRLF vs LF), comments, blank lines,
 * ordering, export prefixes, and untouched lines byte-for-byte.
 */
export function updateEnvText(
  existingText: string,
  updates: Record<string, string>,
  sectionComments?: Record<string, string>,
  keyToSection?: (key: string) => string | undefined,
): string {
  const eol = existingText.includes('\r\n') ? '\r\n' : '\n'
  const hadTrailingEol = existingText === '' || existingText.endsWith('\n')
  const lines = existingText ? existingText.split(/\r?\n/) : []
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  const remainingKeys = new Set(Object.keys(updates))
  const newLines: string[] = []

  let inMultiLine = false
  let currentQuote = ''
  let preserveMultiLine = false

  for (const rawLine of lines) {
    if (inMultiLine) {
      if (preserveMultiLine) {
        newLines.push(rawLine)
      }
      if (rawLine.includes(currentQuote)) {
        inMultiLine = false
        currentQuote = ''
        preserveMultiLine = false
      }
      continue
    }

    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      newLines.push(rawLine)
      continue
    }

    let checkLine = trimmed
    const isExport = checkLine.startsWith('export ')
    if (isExport) {
      checkLine = checkLine.slice(7).trimStart()
    }

    const eqIdx = checkLine.indexOf('=')
    if (eqIdx === -1) {
      newLines.push(rawLine)
      continue
    }

    const key = checkLine.slice(0, eqIdx).trim()
    const afterEq = checkLine.slice(eqIdx + 1).trimStart()
    const startsQuote = afterEq.startsWith('"') || afterEq.startsWith("'")
    const quoteChar = startsQuote ? afterEq[0]! : ''
    const isMultiLineStart = startsQuote && afterEq.indexOf(quoteChar, 1) === -1

    if (key && Object.prototype.hasOwnProperty.call(updates, key)) {
      remainingKeys.delete(key)
      const newVal = updates[key]!

      if (isMultiLineStart) {
        inMultiLine = true
        currentQuote = quoteChar
        preserveMultiLine = false
      }

      const prefix = isExport ? 'export ' : ''
      newLines.push(`${prefix}${key}=${formatEnvValue(newVal)}`)
    } else {
      if (isMultiLineStart) {
        inMultiLine = true
        currentQuote = quoteChar
        preserveMultiLine = true
      }
      newLines.push(rawLine)
    }
  }

  if (remainingKeys.size > 0) {
    if (newLines.length > 0 && newLines[newLines.length - 1] !== '') {
      newLines.push('')
    }

    const grouped = new Map<string, string[]>()
    for (const key of remainingKeys) {
      const section = keyToSection?.(key) ?? 'default'
      const list = grouped.get(section)
      if (list) {
        list.push(key)
      } else {
        grouped.set(section, [key])
      }
    }

    for (const [section, keys] of grouped) {
      const comment = sectionComments?.[section]
      if (comment) {
        if (newLines.length > 0 && newLines[newLines.length - 1] !== '') {
          newLines.push('')
        }
        newLines.push(comment)
      }
      for (const k of keys) {
        newLines.push(`${k}=${formatEnvValue(updates[k]!)}`)
      }
    }
  }

  const joined = newLines.join(eol)
  if (hadTrailingEol && joined.length > 0) {
    return joined + eol
  }
  return joined
}
