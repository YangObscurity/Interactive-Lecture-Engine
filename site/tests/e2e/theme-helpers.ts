/**
 * Theme helpers for e2e (P2b): select a theme pack + VitePress appearance before navigation, and
 * assert the expected pack is active (via the computed `--lec-bg`).
 */
import type { Page } from '@playwright/test'
import { expect } from './fixtures'

export const THEME_MODES = [
  ['reader', 'light'],
  ['reader', 'dark'],
  ['datasheet', 'light'],
  ['datasheet', 'dark'],
] as const
export type ThemeId = (typeof THEME_MODES)[number][0]
export type Mode = (typeof THEME_MODES)[number][1]

/** --lec-bg per theme-mode (spec board THEMES). */
export const BG: Record<`${ThemeId}-${Mode}`, string> = {
  'reader-light': '#FFFFFF',
  'reader-dark': '#17191E',
  'datasheet-light': '#F5F6F3',
  'datasheet-dark': '#0F1D17',
}

export interface ReaderPrefsInit {
  theme?: ThemeId
  tint?: string
  fontSize?: number
  bodyFont?: 'serif' | 'sans'
}

/** Must be called before the first navigation of the page. */
export async function useTheme(page: Page, theme: ThemeId, mode: Mode, extra: Omit<ReaderPrefsInit, 'theme'> = {}): Promise<void> {
  await page.emulateMedia({ colorScheme: mode, reducedMotion: 'reduce' })
  await page.addInitScript(
    ([prefs, m]) => {
      try {
        localStorage.setItem('vitepress-theme-appearance', m)
        localStorage.setItem('lecture:reader-prefs', prefs)
      } catch {
        /* ignore */
      }
    },
    [JSON.stringify({ theme, ...extra }), mode] as const,
  )
}

export async function lecVar(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
}

export async function expectThemeActive(page: Page, theme: ThemeId, mode: Mode): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-lec-theme', theme)
  await expect(page.locator('html')).toHaveClass(mode === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/)
  expect((await lecVar(page, '--lec-bg')).toUpperCase()).toBe(BG[`${theme}-${mode}`])
}
