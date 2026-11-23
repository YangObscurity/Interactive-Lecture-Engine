/**
 * site.config.ts of the engine's demo content: the site a fresh clone, a hosted demo and `npm run build` without a
 * content folder of its own show. It needs no backend at all:
 *   - progress `local`: kept in the reader's browser (no /api/db);
 *   - auth `none`: no sign-in, no identity request (a production build then leaves out /dashboard, P6.5);
 *   - companion `openai-compatible`: the AI companion talks straight from the browser to a service the reader picks,
 *     with the reader's own key (nothing is sent anywhere until a reader enters one). `off` would hide it entirely.
 * No access block: everything is public.
 *
 * The e2e suites test the backend paths (progress rest, trusted-header auth, companion proxy) against the mocked /api of
 * tests/e2e/fixtures.ts with `e2e/site.config.ts` of this folder instead: build_e2e copies the demo content to
 * site/.e2e-demo/content and puts that file in place of this one. The access tiers of the access project are in
 * access.e2e.json (LECTURE_ACCESS_JSON).
 */

export default {
  theme: 'datasheet',
  themes: ['reader'],
  modules: {
    progress: { adapter: 'local' },
    auth: { adapter: 'none' },
    companion: { adapter: 'openai-compatible' },
  },
}
