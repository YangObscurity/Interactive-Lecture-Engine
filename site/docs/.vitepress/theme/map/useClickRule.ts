/**
 * map/useClickRule.ts - `createClickRule` bound to a component: a pending single click is cancelled when the component goes away.
 */
import { getCurrentInstance, onBeforeUnmount } from 'vue'
import { createClickRule } from './clickRule'
import type { ClickRule, ClickRuleOptions } from './clickRule'

export function useClickRule(options: ClickRuleOptions = {}): ClickRule {
  const rule = createClickRule(options)
  if (getCurrentInstance()) onBeforeUnmount(rule.cancel)
  return rule
}
