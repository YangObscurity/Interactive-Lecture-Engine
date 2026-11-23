/**
 * theme/tokens/categories.ts — course-group category → colour slot (pure).
 *
 * Slots are handed out by FIRST APPEARANCE of a category in the group list (the order of
 * `GROUPS` in groups.mts), 1-based, wrapping after `slotCount` (default 8 = `--lec-cat-1…8`).
 * Groups without `category` share one "uncategorised" bucket, which takes a slot at its own first
 * appearance like any other category — so a site without categories paints every group with
 * `--lec-cat-1`, deterministically. `accent` stays an optional per-group override on top.
 */
import { CATEGORY_SLOTS } from './contract'

export interface CategorisedGroup {
  id: string
  category?: string
}

/** Key used for groups without a category (cannot collide with a real, trimmed category). */
export const UNCATEGORISED = '\u0000uncategorised'

export function categoryKey(g: CategorisedGroup): string {
  const c = typeof g.category === 'string' ? g.category.trim() : ''
  return c === '' ? UNCATEGORISED : c
}

/** category key → slot (1…slotCount). */
export function assignCategorySlots(groups: readonly CategorisedGroup[], slotCount: number = CATEGORY_SLOTS): Map<string, number> {
  if (!Number.isInteger(slotCount) || slotCount < 1) throw new RangeError(`slotCount must be a positive integer, got ${slotCount}`)
  const slots = new Map<string, number>()
  for (const g of groups) {
    const key = categoryKey(g)
    if (!slots.has(key)) slots.set(key, (slots.size % slotCount) + 1)
  }
  return slots
}

/** group id → slot, for every group. */
export function groupSlots(groups: readonly CategorisedGroup[], slotCount: number = CATEGORY_SLOTS): Map<string, number> {
  const bySlot = assignCategorySlots(groups, slotCount)
  return new Map(groups.map((g) => [g.id, bySlot.get(categoryKey(g)) as number]))
}

/** CSS colour for a group: explicit `accent` override, else its category slot variable. */
export function groupColor(slot: number, accent?: string): string {
  return accent && accent.trim() ? accent : `var(--lec-cat-${slot})`
}
