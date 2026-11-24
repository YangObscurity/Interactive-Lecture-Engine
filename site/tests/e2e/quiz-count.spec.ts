/**
 * Quiz headers on filled-in demo lectures (S6X; counting decided by the user 2026-11-23 21:40: one question per nested
 * answer block, a card without answers is one question). Since S6X Q the demo writes every self-test question as its
 * own `**第 N 题**` paragraph followed by its own `::: details 答案` block (English: `**Question N**`, `Answer`) inside one
 * `:::: details 自测题` card, so mea/L01 (three questions) says 共 3 题. No header is ever put inside an answer block.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, gotoAndSettle } from './fixtures'
import { DEMO_DIR } from './demo'

const answerBlocks = (rel: string, label: string) =>
  (fs.readFileSync(path.join(DEMO_DIR, 'lectures', rel), 'utf8').match(new RegExp(`^:::\\s*details\\s+${label}\\s*$`, 'gm')) ?? []).length

const CARD = '.vp-doc details.details.custom-block'
const NESTED = `${CARD} details.details.custom-block`
const HEADER_IN_DETAILS = '.vp-doc details.details [data-slot="QuizHeader"], .vp-doc details.details .lec-quiz-host'

test('mea/L01: one self-test card of three questions, each with its own answer block: 共 3 题, no header in the answers', async ({ page, pageErrors }) => {
  expect(answerBlocks('mea/L01.md', '答案'), 'mea/L01 source: one answer block per question').toBe(3)
  await gotoAndSettle(page, '/mea/L01')
  const headers = page.locator('.vp-doc [data-slot="QuizHeader"]')
  await expect(headers).toHaveCount(1)
  await expect(headers.first()).toContainText('自测 1-1')
  await expect(headers.first()).toContainText('共 3 题')
  await expect(page.locator(NESTED)).toHaveCount(3)
  for (const n of [1, 2, 3]) await expect(page.locator(CARD).first()).toContainText(`第 ${n} 题`)
  expect(await page.locator(HEADER_IN_DETAILS).count()).toBe(0)
  expect(pageErrors).toEqual([])
})

test('en/log/L04: the English self-check has three Answer blocks: "3 items", no header in the answers', async ({ page, pageErrors }) => {
  expect(answerBlocks('en/log/L04.md', 'Answer'), 'en/log/L04 source: one Answer block per question').toBe(3)
  await gotoAndSettle(page, '/en/log/L04')
  const headers = page.locator('.vp-doc [data-slot="QuizHeader"]')
  await expect(headers).toHaveCount(1)
  await expect(headers.first()).toContainText('Check 4-1')
  await expect(headers.first()).toContainText('3 items')
  await expect(page.locator(NESTED)).toHaveCount(3)
  for (const n of [1, 2, 3]) await expect(page.locator(CARD).first()).toContainText(`Question ${n}`)
  expect(await page.locator(HEADER_IN_DETAILS).count()).toBe(0)
  expect(pageErrors).toEqual([])
})
