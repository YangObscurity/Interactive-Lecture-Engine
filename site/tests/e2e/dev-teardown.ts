/**
 * Global teardown of the `dev` Playwright project (registered by playwright.config.ts only when dev is selected).
 *
 * scripts/dev_e2e.mjs synced the demo copy (site/.e2e-demo/content) into site/docs before it started vitepress. Playwright
 * runs this teardown before it stops its web servers, and on Windows it stops them with `taskkill /T /F`, which skips
 * every signal handler of the server script. So the server is stopped here and site/docs is put back for the site's own
 * content (content:sync of its content folder, or --clean when it has none). Also after Ctrl-C, which still runs the
 * teardown; a run killed outright is cleaned up on the next start or with `node scripts/dev_e2e.mjs --restore`.
 */
import { teardownDevServer } from '../../scripts/dev_e2e.mjs'

export default async function devTeardown(): Promise<void> {
  const code = await teardownDevServer('playwright teardown')
  if (code !== 0) throw new Error('dev e2e: could not put site/docs back; run `npm run content:sync` in site/')
}
