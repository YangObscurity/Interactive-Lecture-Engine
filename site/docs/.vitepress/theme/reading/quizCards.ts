/**
 * reading/quizCards.ts — which `details` blocks of a lecture are quiz cards, and how many questions each holds (S6X).
 * Kept apart from quiz.ts (which mounts Vue slots) so it is a plain DOM function.
 *
 * The quiz cards of a page are the `details.details.custom-block` blocks of `.vp-doc` that are not inside another such
 * block. A details block nested in a quiz card (the usual `::: details 答案` inside `:::: details 自测题`) is part of
 * that card, not a card of its own: it gets no header.
 *
 * Counting (user decision 2026-11-23 21:40): a card counts one question per nested answer block, so a 自测题 card with
 * three `::: details 答案` inside is three questions; a card without nested answers is one question. The page total is
 * the sum over its cards, and each card's header carries the number of its first question.
 */
const CARD = 'details.details.custom-block'

export function quizCards(root: ParentNode): HTMLDetailsElement[] {
  return Array.from(root.querySelectorAll<HTMLDetailsElement>(`.vp-doc ${CARD}`)).filter((det) => !det.parentElement?.closest(CARD))
}

/** questions of one card: its nested answer blocks, at least 1 */
export function quizQuestionCount(card: Element): number {
  return Math.max(1, card.querySelectorAll(CARD).length)
}

export interface QuizPlanItem {
  card: HTMLDetailsElement
  /** number of the card's first question, from 1 */
  index: number
  /** questions in the card */
  count: number
}

/** every quiz card of the page with the number of its first question, and the page's question total */
export function quizPlan(root: ParentNode): { items: QuizPlanItem[]; total: number } {
  const items: QuizPlanItem[] = []
  let next = 1
  for (const card of quizCards(root)) {
    const count = quizQuestionCount(card)
    items.push({ card, index: next, count })
    next += count
  }
  return { items, total: next - 1 }
}
