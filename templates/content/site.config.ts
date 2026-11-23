/**
 * site.config.ts — this site's settings (no secrets). The engine reads it with loadLectureConfig() and checks it;
 * every field is documented in site/docs/.vitepress/lecture-config.mts of the engine.
 *
 * theme      default theme pack: 'datasheet' or 'reader'
 * themes     other themes a reader may switch to
 * modules    optional site modules, for example { progress: { adapter: 'rest' }, companion: { adapter: 'proxy' } };
 *            omitted modules use the engine defaults. Secrets go to .env (`npm run setup`), never here.
 * access     optional access tiers: { default: 'public' | 'authenticated', enforcement: 'none' | 'gateway',
 *            groups: { <group id>: { read: 'public' | 'authenticated' | ['<gateway user group>', ...] } } }
 *            (engine docs-dev/ACCESS.md). Omitted = every group is public.
 * i18n       optional languages: { root: 'zh-CN', locales: ['zh-CN', 'en'] } are the defaults.
 */

export default {
  theme: 'datasheet',
  themes: ['reader'],
}
