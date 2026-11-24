import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_BACKUP_DIR = resolve(MODULE_DIR, '../../backups')

export function resolveBackupDir(explicitDir?: string, envVar?: string): string {
  const chosen = explicitDir?.trim() || envVar?.trim() || process.env.BACKUP_DIR?.trim()
  return chosen ? resolve(chosen) : DEFAULT_BACKUP_DIR
}
