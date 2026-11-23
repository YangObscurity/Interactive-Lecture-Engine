/**
 * lecture.config.ts — the engine's default site configuration.
 *
 * Used only when there is no content directory: a site's own settings live in `content/site.config.ts`
 * (or the folder named by LECTURE_CONTENT_DIR), which replaces this file as a whole. The fields are
 * documented in docs/.vitepress/lecture-config.mts. Secrets never go here.
 */
import { defineLectureConfig } from './docs/.vitepress/lecture-config.mts'

export default defineLectureConfig({
  theme: 'datasheet',
  themes: ['reader'],
})
