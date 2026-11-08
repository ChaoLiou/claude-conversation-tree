/**
 * Run the built content script on the real claude.ai page, with no install.
 *
 * Current Chrome refuses to load an unpacked extension from the command
 * line, and its `Extensions.loadUnpacked` command returns an id without
 * registering anything. So the dev loop injects the same bundle instead.
 *
 * What this covers, and what it does not:
 *   covered      the DOM adapter, the sync rules, the panel, the real markup
 *   not covered  the manifest, and `browser.storage`
 *
 * The content script falls back to `localStorage` when no extension API is
 * there, so a dev run stores the tree under the claude.ai origin.
 *
 * The injection lasts only while this process stays attached. It is here to
 * let you look at the panel by hand. For a check that runs on its own, use
 * `pnpm verify`, which injects inside its own session.
 *
 * Usage:
 *   pnpm build && pnpm inject            inject, then hold the tab open
 */
import { Cdp, cdpVersion, findPage, openPage } from './cdp.mjs';
import { registerBundle, readBundle } from './inject-lib.mjs';

const PORT = Number(process.env.CDP_PORT ?? 9222);

function log(...parts) { console.log('[inject]', ...parts); }

const version = await cdpVersion(PORT);
log('Chrome:', version.Browser);
log(`bundle: ${(readBundle().length / 1024).toFixed(1)} KiB`);

let target = await findPage('claude.ai', PORT);
if (target === null) {
  log('no claude.ai tab; opening one');
  await openPage('https://claude.ai/new', PORT);
  await new Promise((r) => setTimeout(r, 2500));
  target = await findPage('claude.ai', PORT);
}
if (target === null) {
  console.error('[inject] could not open a claude.ai tab');
  process.exit(1);
}

const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
const mounted = await registerBundle(cdp);
if (!mounted) {
  console.error('[inject] the panel did not mount. Check the page console.');
  process.exit(1);
}

log('the panel is on the page.');
log('This process must stay open, or the injection goes away.');
log('Press ctrl+c when you have finished looking.');
await new Promise(() => {});
