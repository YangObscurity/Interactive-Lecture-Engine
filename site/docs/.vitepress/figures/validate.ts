/**
 * Ajv-backed validator for `<figuresDir>/<group>/figures.json` and on-disk files.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import AjvMod from 'ajv'
import type { ValidateFunction } from 'ajv'
import {
  DEFAULT_FIGURE_EXTS,
  ORIGINAL_FIGURE_EXTS,
  validateDoi,
  validateExternalUrl,
  validateSafeFigureRelPath,
} from './pathGuard.ts'
import { FIGURES_REGISTRY_SCHEMA } from './schema.ts'
import type { FigureEntry, FiguresRegistry } from './types.ts'

type AjvCtor = new (opts?: Record<string, unknown>) => { compile: <T>(schema: unknown) => ValidateFunction<T> }
const AjvClass = ((AjvMod as unknown as { default?: AjvCtor }).default ?? (AjvMod as unknown as AjvCtor))
const ajvInstance = new AjvClass({ allErrors: true, strict: false })
const compiledValidate = ajvInstance.compile<FiguresRegistry>(FIGURES_REGISTRY_SCHEMA)

export interface ValidateRegistryOptions {
  /** Expected group directory string (`lr`, `examples/g01`, ...). */
  expectedGroup?: string
  /** Absolute directory on disk (`<figuresDir>/<group>`). When given + verifyFiles, asserts existence, containment, and sha256. */
  groupDir?: string
  /** Verify referenced files exist inside `groupDir` and match `sha256`. */
  verifyFiles?: boolean
}

export interface ValidationResult {
  ok: boolean
  registry: FiguresRegistry | null
  errors: string[]
  warnings: string[]
}

export function sha256First12(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 12)
}

/**
 * Checksum of a figure file as stored in the registry. SVG is text: a checkout with `core.autocrlf` rewrites its line
 * endings, so CRLF is folded to LF before hashing (the import script does the same). Binary formats hash as they are.
 */
export function figureFileChecksum(file: string, buf: Buffer): string {
  if (!file.toLowerCase().endsWith('.svg')) return sha256First12(buf)
  return sha256First12(Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'))
}

function isContainedInside(rootReal: string, candidatePath: string): boolean {
  const rel = path.relative(rootReal, candidatePath)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function resolveContainedFigureFile(groupDir: string, relFile: string): string | null {
  const rootReal = existsSync(groupDir) ? realpathSync(groupDir) : path.resolve(groupDir)
  const resolved = path.resolve(rootReal, relFile)
  if (!isContainedInside(rootReal, resolved)) return null
  if (existsSync(resolved)) {
    const fileReal = realpathSync(resolved)
    if (!isContainedInside(rootReal, fileReal)) return null
  }
  return resolved
}

export function validateFiguresRegistry(data: unknown, opts: ValidateRegistryOptions = {}): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  const valid = compiledValidate(data)
  if (!valid) {
    for (const err of compiledValidate.errors ?? []) {
      const at = err.instancePath || '/'
      const extra =
        err.keyword === 'additionalProperties' && typeof err.params?.additionalProperty === 'string'
          ? ` (${err.params.additionalProperty})`
          : ''
      errors.push(`${at} ${err.message ?? 'schema violation'}${extra}`)
    }
    return { ok: false, registry: null, errors, warnings }
  }

  const reg = data as FiguresRegistry
  if (opts.expectedGroup && reg.group !== opts.expectedGroup) {
    errors.push(`registry group "${reg.group}" does not match expected group "${opts.expectedGroup}"`)
  }

  const seenIds = new Set<string>()
  for (let i = 0; i < reg.figures.length; i++) {
    const entry = reg.figures[i] as FigureEntry
    if (seenIds.has(entry.id)) {
      errors.push(`figures[${i}].id duplicate id "${entry.id}" in group "${reg.group}"`)
    }
    seenIds.add(entry.id)

    const fileGuard = validateSafeFigureRelPath(entry.file, { allowedExts: DEFAULT_FIGURE_EXTS })
    if (!fileGuard.ok) {
      errors.push(`figures[${i}].file (${entry.id}): ${fileGuard.reason}`)
    }

    if (entry.original !== undefined) {
      const origGuard = validateSafeFigureRelPath(entry.original, { allowedExts: ORIGINAL_FIGURE_EXTS })
      if (!origGuard.ok) {
        errors.push(`figures[${i}].original (${entry.id}): ${origGuard.reason}`)
      }
    }

    if (entry.url !== undefined && !validateExternalUrl(entry.url)) {
      errors.push(`figures[${i}].url (${entry.id}): must be an http(s) URL`)
    }
    if (entry.doi !== undefined && !validateDoi(entry.doi)) {
      errors.push(`figures[${i}].doi (${entry.id}): invalid DOI format (expected 10.xxxx/...)`)
    }

    if (opts.verifyFiles && opts.groupDir && fileGuard.ok) {
      const diskPath = resolveContainedFigureFile(opts.groupDir, fileGuard.normalized)
      if (!diskPath || !existsSync(diskPath) || !statSync(diskPath).isFile()) {
        errors.push(`figures[${i}].file (${entry.id}): file not found on disk: ${entry.file}`)
      } else {
        const buf = readFileSync(diskPath)
        const digest = figureFileChecksum(diskPath, buf)
        if (digest !== entry.sha256) {
          errors.push(`figures[${i}].sha256 (${entry.id}): checksum mismatch (expected ${entry.sha256}, actual ${digest})`)
        }
      }
      if (entry.original !== undefined) {
        const origGuard = validateSafeFigureRelPath(entry.original, { allowedExts: ORIGINAL_FIGURE_EXTS })
        if (origGuard.ok) {
          const origDisk = resolveContainedFigureFile(opts.groupDir, origGuard.normalized)
          if (!origDisk || !existsSync(origDisk) || !statSync(origDisk).isFile()) {
            errors.push(`figures[${i}].original (${entry.id}): original file not found on disk: ${entry.original}`)
          }
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    registry: errors.length === 0 ? reg : null,
    errors,
    warnings,
  }
}
