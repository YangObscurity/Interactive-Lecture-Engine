/**
 * site.config.ts the e2e suites build the demo content with (not the demo site's own: that one is ../site.config.ts and
 * needs no backend). Same modules as a site with a backend (progress rest, trusted-header auth, companion proxy), so
 * the specs exercise those paths against the mocked /api of site/tests/e2e/fixtures.ts.
 *
 * site/scripts/build_e2e.mjs copies templates/demo-content to site/.e2e-demo/content (git-ignored), puts this file
 * there as site.config.ts, drops this e2e/ folder from the copy, and builds with LECTURE_CONTENT_DIR pointing at the copy.
 * No access block: the prod and dev projects build an all-public site; the access project sets its tiers with
 * LECTURE_ACCESS_JSON (../access.e2e.json).
 */

export default {
  theme: 'datasheet',
  themes: ['reader'],
  modules: {
    progress: { adapter: 'rest', notionSync: true },
    auth: { adapter: 'trusted-header' },
    companion: { adapter: 'proxy' },
  },
}
