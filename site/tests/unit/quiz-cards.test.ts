// @vitest-environment happy-dom
/**
 * reading/quizCards.ts: quiz headers go on the top-level `::: details` cards only; a details block nested in a card (the
 * answer of a self-test, `::: details 答案` inside `:::: details 自测题`) belongs to that card and gets no header.
 * Counting (user decision 2026-11-23 21:40): one question per nested answer, a card without answers is one question.
 */
import { describe, expect, it } from 'vitest'
import { quizCards, quizPlan, quizQuestionCount } from '../../docs/.vitepress/theme/reading/quizCards'

const card = (title: string, inner = ''): string => `<details class="details custom-block"><summary>${title}</summary><p>q</p>${inner}</details>`
const answers = (n: number): string => Array.from({ length: n }, (_, i) => `<p>题 ${i + 1}</p>${card('答案')}`).join('')

describe('quizCards / quizPlan', () => {
  it('a card with 3 nested answers is 3 questions', () => {
    document.body.innerHTML = `<div class="vp-doc">${card('自测题', answers(3))}</div>`
    const plan = quizPlan(document)
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]).toMatchObject({ index: 1, count: 3 })
    expect(plan.total).toBe(3)
  })

  it('a card without nested answers is 1 question', () => {
    document.body.innerHTML = `<div class="vp-doc">${card('自测题')}</div>`
    expect(quizPlan(document)).toMatchObject({ total: 1, items: [{ index: 1, count: 1 }] })
  })

  it('several cards on a page: totals add up, each card numbered from its first question', () => {
    document.body.innerHTML = `<div class="vp-doc">${card('自测题', answers(3))}<p>x</p>${card('练习')}<section>${card('思考', answers(2))}</section></div>`
    const plan = quizPlan(document)
    expect(plan.items.map((i) => [i.card.querySelector('summary')?.textContent, i.index, i.count])).toEqual([
      ['自测题', 1, 3],
      ['练习', 4, 1],
      ['思考', 5, 2],
    ])
    expect(plan.total).toBe(6)
  })

  it('answer blocks are never cards (no header goes inside an answer), at any depth', () => {
    document.body.innerHTML = `<div class="vp-doc">${card('自测题', card('答案', card('提示')))}</div>`
    const cards = quizCards(document)
    expect(cards.map((d) => d.querySelector('summary')?.textContent)).toEqual(['自测题'])
    expect(quizQuestionCount(cards[0] as Element)).toBe(2)
  })

  it('only cards inside .vp-doc count, and a plain details (not a custom block) does not hide the cards inside it', () => {
    document.body.innerHTML = `${card('outside')}<div class="vp-doc"><details><summary>raw</summary>${card('卡')}</details>${card('二')}</div>`
    expect(quizCards(document)).toHaveLength(2)
  })
})
