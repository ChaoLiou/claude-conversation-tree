/**
 * Put the built content script into a page over the DevTools protocol.
 *
 * `Page.addScriptToEvaluateOnNewDocument` lasts only while the client that
 * registered it stays attached. So every tool that needs the panel must
 * register the bundle itself, inside its own session.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BUNDLE_PATH = join(HERE, '..', 'dist', 'chrome', 'content.js');

export function readBundle() {
  try {
    return readFileSync(BUNDLE_PATH, 'utf8');
  } catch {
    throw new Error(`${BUNDLE_PATH} is missing. Run: pnpm build`);
  }
}

/**
 * Register the bundle for this tab, then reload so it runs.
 * It returns true when the panel reached the page.
 */
export async function registerBundle(cdp, { reload = true, waitMs = 4500 } = {}) {
  const source = readBundle();
  const guarded = `
if (window.__claudeTreeInjected !== true) {
  window.__claudeTreeInjected = true;
  try { ${source} } catch (e) { console.error('[claude-tree] boot failed', e); }
}`;
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: guarded });
  if (!reload) return false;
  await cdp.send('Page.reload', {});
  await new Promise((r) => setTimeout(r, waitMs));
  return waitForPanel(cdp);
}

/** Wait until the panel host appears. */
export async function waitForPanel(cdp, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const there = await cdp.evaluate(
      `document.getElementById('claude-tree-panel-host') !== null`,
    );
    if (there === true) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
