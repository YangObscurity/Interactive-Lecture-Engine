import type { Role } from '../config/schema.js'

/**
 * Resolves user roles from gateway groups and configured role mapping.
 *
 * Rules:
 * - 'reader' is always included as the base role.
 * - Each group in `groups` is checked against `roleMap` in encounter order.
 * - Any mapped roles are appended if not already present.
 * - Deduplication preserves encounter order.
 */
export function resolveRoles(
  groups: readonly string[],
  roleMap: Record<string, readonly Role[]>,
): Role[] {
  const result: Role[] = ['reader']
  const seen = new Set<Role>(['reader'])

  for (const group of groups) {
    const mapped = roleMap[group]
    if (mapped) {
      for (const role of mapped) {
        if (!seen.has(role)) {
          seen.add(role)
          result.push(role)
        }
      }
    }
  }

  return result
}
