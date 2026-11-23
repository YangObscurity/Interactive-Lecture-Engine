import type { ConceptMatchKind, ConceptRecord, ConceptSearchHit, LectureRecord, LectureSearchHit } from './types.js'

/** Normalise text for concept/alias/lecture comparison: NFKC, lowercase, strip whitespace and punctuation. */
export function normalizeSearchText(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]+/gu, '')
}

function buildBigrams(s: string): string[] {
  if (s.length < 2) return s.length === 1 ? [s] : []
  const out: string[] = []
  for (let i = 0; i < s.length - 1; i++) {
    out.push(s.slice(i, i + 2))
  }
  return out
}

export function bigramSimilarity(aRaw: string, bRaw: string): number {
  const a = normalizeSearchText(aRaw)
  const b = normalizeSearchText(bRaw)
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length === 1 || b.length === 1) {
    return b.includes(a) || a.includes(b) ? 0.5 : 0
  }

  const aGrams = buildBigrams(a)
  const bGrams = buildBigrams(b)
  const counts = new Map<string, number>()
  for (const g of aGrams) {
    counts.set(g, (counts.get(g) ?? 0) + 1)
  }

  let intersection = 0
  for (const g of bGrams) {
    const c = counts.get(g) ?? 0
    if (c > 0) {
      intersection++
      counts.set(g, c - 1)
    }
  }

  return (2 * intersection) / (aGrams.length + bGrams.length)
}

function fuzzyFieldScore(qNorm: string, targetRaw: string): number {
  const tNorm = normalizeSearchText(targetRaw)
  if (!qNorm || !tNorm) return 0
  if (qNorm === tNorm) return 0.88
  const sim = bigramSimilarity(qNorm, tNorm)
  let substringBonus = 0
  if (tNorm.includes(qNorm)) {
    substringBonus = Math.min(0.84, 0.45 + 0.35 * (qNorm.length / tNorm.length))
  } else if (qNorm.includes(tNorm) && tNorm.length >= 2) {
    substringBonus = Math.min(0.75, 0.35 + 0.3 * (tNorm.length / qNorm.length))
  }
  return Math.min(0.88, Math.max(sim, substringBonus))
}

const MATCH_RANK: Record<ConceptMatchKind, number> = {
  exact: 4,
  alias: 3,
  english: 2,
  fuzzy: 1,
}

export function rankConcepts(
  concepts: Iterable<ConceptRecord>,
  query: string,
  limit = 8,
): ConceptSearchHit[] {
  const qNorm = normalizeSearchText(query)
  if (!qNorm) return []

  const hits: ConceptSearchHit[] = []

  for (const c of concepts) {
    const termNorm = normalizeSearchText(c.term)
    const englishNorm = c.english ? normalizeSearchText(c.english) : ''
    const aliasNorms = c.aliases.map(normalizeSearchText)

    let match: ConceptMatchKind | null = null
    let score = 0

    if (termNorm && termNorm === qNorm) {
      match = 'exact'
      score = 1
    } else if (aliasNorms.some((a) => a !== '' && a === qNorm)) {
      match = 'alias'
      score = 0.95
    } else if (englishNorm && englishNorm === qNorm) {
      match = 'english'
      score = 0.9
    } else {
      const candidates = [c.term, ...c.aliases, c.english]
      let best = 0
      for (const candidate of candidates) {
        if (!candidate) continue
        const s = fuzzyFieldScore(qNorm, candidate)
        if (s > best) best = s
      }
      if (best === 0 && c.summary) {
        const sumScore = fuzzyFieldScore(qNorm, c.summary) * 0.45
        if (sumScore > 0.08) best = sumScore
      }
      if (best >= 0.12) {
        match = 'fuzzy'
        score = Number(best.toFixed(4))
      }
    }

    if (match !== null) {
      hits.push({
        slug: c.slug,
        term: c.term,
        english: c.english,
        aliases: c.aliases,
        summary: c.summary,
        url: c.url,
        match,
        score,
      })
    }
  }

  hits.sort((a, b) => {
    const rankDiff = MATCH_RANK[b.match] - MATCH_RANK[a.match]
    if (rankDiff !== 0) return rankDiff
    if (b.score !== a.score) return b.score - a.score
    return a.slug.localeCompare(b.slug)
  })

  return hits.slice(0, limit)
}

function extractTokens(query: string): string[] {
  const rawTokens = query
    .normalize('NFKC')
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  return [...new Set(rawTokens)]
}

function buildSnippet(text: string, query: string, tokens: readonly string[]): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= 200) return compact

  const lower = compact.normalize('NFKC').toLowerCase()
  const qLower = query.normalize('NFKC').toLowerCase().trim()
  let idx = qLower ? lower.indexOf(qLower) : -1
  if (idx < 0) {
    for (const tok of tokens) {
      const found = lower.indexOf(tok)
      if (found >= 0) {
        idx = found
        break
      }
    }
  }

  if (idx < 0) return `${compact.slice(0, 197)}...`
  const start = Math.max(0, idx - 60)
  const end = Math.min(compact.length, start + 200)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < compact.length ? '...' : ''
  return `${prefix}${compact.slice(start, end).trim()}${suffix}`
}

export function rankLectures(
  lectures: Iterable<LectureRecord>,
  query: string,
  group?: string,
  limit = 8,
): LectureSearchHit[] {
  const qNorm = normalizeSearchText(query)
  if (!qNorm) return []

  const groupNorm = group ? group.trim().toLowerCase() : null
  const tokens = extractTokens(query)
  const hits: LectureSearchHit[] = []

  for (const lecture of lectures) {
    if (groupNorm && lecture.group.trim().toLowerCase() !== groupNorm) {
      continue
    }

    const titleNorm = normalizeSearchText(lecture.title)

    for (const section of lecture.sections) {
      const headingNorm = normalizeSearchText(section.heading)
      const textNorm = normalizeSearchText(section.text)

      let score = 0
      if (headingNorm === qNorm) {
        score = 1
      } else if (titleNorm === qNorm) {
        score = 0.95
      } else {
        if (headingNorm.includes(qNorm)) score += 0.65
        if (titleNorm.includes(qNorm)) score += 0.45
        if (textNorm.includes(qNorm)) score += 0.5

        if (tokens.length > 0) {
          let tokenHits = 0
          const combinedRaw = `${lecture.title} ${section.heading} ${section.text}`.normalize('NFKC').toLowerCase()
          for (const tok of tokens) {
            if (combinedRaw.includes(tok)) tokenHits++
          }
          score += (tokenHits / tokens.length) * 0.45
        }

        const sim = Math.max(
          bigramSimilarity(qNorm, headingNorm),
          bigramSimilarity(qNorm, titleNorm) * 0.8,
          bigramSimilarity(qNorm, textNorm.slice(0, 400)) * 0.6,
        )
        score = Math.max(score, sim)
      }

      if (score >= 0.15) {
        hits.push({
          id: lecture.id,
          route: lecture.route,
          title: lecture.title,
          heading: section.heading,
          anchor: section.anchor,
          snippet: buildSnippet(section.text || section.heading, query, tokens),
          score: Number(Math.min(1, score).toFixed(4)),
        })
      }
    }
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const idCmp = a.id.localeCompare(b.id)
    if (idCmp !== 0) return idCmp
    return a.anchor.localeCompare(b.anchor)
  })

  return hits.slice(0, limit)
}
