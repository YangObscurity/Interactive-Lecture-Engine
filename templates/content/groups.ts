/**
 * groups.ts — the course groups of this site (data only; the engine checks the fields).
 *
 * Add a group with `npm run new:group` (it appends an entry here and creates lectures/<dir>/index.md).
 * Fields of one entry:
 *   id        short code shown on cards and used as the chart prefix, e.g. 'G01' (charts/G01-L03.json)
 *   dir       folder under lectures/, e.g. 'g01'
 *   title     course name; tagline: one line; summary: what the group covers
 *   accent    card colour (hex); tags: keywords
 *   category  optional category name (groups with one category share a colour slot)
 *   temp      optional: formal temporary group (sorted last, marked Temp, DB/local progress only — no Notion sync);  map: false keeps it off the home map
 *   i18n      optional translations: { en: { title, tagline, summary, category } }
 * Lecture and chart counts are never written here: the engine counts the files.
 */

export const GROUPS = [
]
