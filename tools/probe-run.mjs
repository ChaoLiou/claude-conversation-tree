/**
 * Drive the probe from WSL. You paste nothing.
 *
 * It opens a fresh conversation in the dev Chrome, sends a few tiny
 * messages, and records what the page did. The messages are markers that
 * this script chose, so the probe can point at the exact element that holds
 * each one. No clicking, and no guessed CSS selector.
 *
 * Before the first run:
 *   tools/dev-chrome.sh          then sign in to claude.ai in that window
 *
 * Then, as often as you like:
 *   pnpm probe
 *
 * The result lands in .probe-output/ as JSON and as a screenshot.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, cdpVersion, findPage, openPage } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = join(ROOT, '.probe-output');
const PORT = Number(process.env.CDP_PORT ?? 9222);
const TURNS = Number(process.env.PROBE_TURNS ?? 3);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const token = 'ZPB' + Math.random().toString(36).slice(2, 7).toUpperCase();

function log(...parts) {
  console.log('[probe]', ...parts);
}

function die(message, hint) {
  console.error('\n[probe] ERROR: ' + message);
  if (hint) console.error('[probe] ' + hint);
  process.exit(1);
}

async function main() {
  // 1. Is the dev Chrome up?
  try {
    const v = await cdpVersion(PORT);
    log('Chrome:', v.Browser);
  } catch {
    die(
      `nothing answers the debug port ${PORT}`,
      'Start it first:  tools/dev-chrome.sh',
    );
  }

  // 2. Find or open a claude.ai tab.
  let target = await findPage('claude.ai', PORT);
  if (target === null) {
    log('no claude.ai tab; opening one');
    target = await openPage('https://claude.ai/new', PORT);
    await new Promise((r) => setTimeout(r, 2500));
    target = await findPage('claude.ai', PORT);
  }
  if (target === null) die('could not open a claude.ai tab');

  const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 3. Are we signed in?
  const href = await cdp.evaluate('location.href');
  if (/\/login|\/signin|\/oauth/.test(href)) {
    cdp.close();
    die(
      'the dev profile is not signed in to claude.ai',
      'Sign in once in the Chrome window that tools/dev-chrome.sh opened, then run this again. The profile keeps the session.',
    );
  }

  // 4. Install the page half BEFORE the page scripts run, so the network
  //    hooks catch the very first call.
  const probeSource = readFileSync(join(HERE, 'probe-core.js'), 'utf8');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: probeSource });
  log('probe installed for every new document');

  // 5. Start a fresh conversation, so no real chat is touched.
  log('opening a new conversation');
  await cdp.send('Page.navigate', { url: 'https://claude.ai/new' });
  await new Promise((r) => setTimeout(r, 3000));
  await cdp.evaluate(probeSource); // belt and braces, for the current document

  // 6. Wait for the composer.
  let ready = false;
  for (let i = 0; i < 40; i++) {
    ready = await cdp.evaluate('window.__probe !== undefined && __probe.hasComposer()');
    if (ready) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    const where = await cdp.evaluate('location.href');
    cdp.close();
    die('the message box never appeared. The page is at: ' + where);
  }
  log('message box found');

  const report = {
    probeVersion: 3,
    probedAt: new Date().toISOString(),
    token,
    turnsRequested: TURNS,
    turns: [],
    roleDiscriminators: null,
    census: null,
    uuidAnchors: [],
    conversationIdFound: false,
    net: [],
    warnings: [],
  };

  // 7. Send the markers, one at a time.
  for (let i = 1; i <= TURNS; i++) {
    const marker = `${token}-${i}`;
    const text = `${marker} reply with only: OK`;
    log(`turn ${i}/${TURNS}: sending marker ${marker}`);

    await cdp.evaluate('__probe.snapshot()');
    const focused = await cdp.evaluate('__probe.focusComposer()');
    if (!focused) report.warnings.push(`turn ${i}: could not focus the message box`);

    await cdp.send('Input.insertText', { text });
    await new Promise((r) => setTimeout(r, 400));
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r',
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter',
    });

    const settled = await cdp.evaluate('__probe.waitSettled(1800, 90000)');
    log(`  settled after ${settled?.waitedMs}ms (quiet: ${settled?.settled})`);
    if (settled && settled.settled === false) report.warnings.push(`turn ${i}: the reply never settled`);

    const turn = await cdp.evaluate(`__probe.analyzeTurn(${JSON.stringify(text)}, ${i})`);
    if (turn.userMessage === null) report.warnings.push(`turn ${i}: the question element was not found`);
    if (turn.assistantMessage === null) report.warnings.push(`turn ${i}: the reply element was not found`);
    report.turns.push({ index: i, ...turn });

    if (i === 1) {
      report.roleDiscriminators = await cdp.evaluate(
        `__probe.roleDiscriminators(__probe.analyzeTurn(${JSON.stringify(text)}, ${i}))`,
      );
    }
  }

  // 8. Collect the rest.
  report.census = await cdp.evaluate('__probe.census()');
  report.transcript = await cdp.evaluate('__probe.transcript()');
  report.uuidOverlap = await cdp.evaluate('__probe.uuidOverlap()');
  report.sockets = await cdp.evaluate('JSON.parse(JSON.stringify(__probe.socketStats()))');
  report.conversationIdFound = Boolean(await cdp.evaluate('__probe.conversationId()'));
  report.path = await cdp.evaluate('__probe.path()');
  report.net = await cdp.evaluate('JSON.parse(JSON.stringify(__probe.net))');

  // Where does a message uuid live in the page? That is our anchor.
  const uuids = await cdp.evaluate('__probe.uuidList()');
  log(`${uuids.length} uuid(s) seen on the wire; looking for them in the DOM`);
  for (const uuid of uuids.slice(0, 25)) {
    const hits = await cdp.evaluate(`__probe.findUuidInDom(${JSON.stringify(uuid)})`);
    if (hits.length > 0) report.uuidAnchors.push({ uuid: 'redacted', hits });
  }
  report.uuidTotal = uuids.length;
  report.uuidWithDomAnchor = report.uuidAnchors.length;

  // 9. Save.
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `probe-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const latestPath = join(OUT_DIR, 'latest.json');
  writeFileSync(latestPath, JSON.stringify(report, null, 2));

  try {
    const png = await cdp.screenshot();
    writeFileSync(join(OUT_DIR, `probe-${stamp}.png`), png);
    writeFileSync(join(OUT_DIR, 'latest.png'), png);
  } catch (e) {
    report.warnings.push('the screenshot failed: ' + String(e.message || e));
  }

  cdp.close();

  log('');
  log('wrote ' + jsonPath);
  log('wrote ' + latestPath);
  log('');
  log('summary:');
  log('  turns analysed      : ' + report.turns.length);
  log('  question found      : ' + report.turns.filter((t) => t.userMessage !== null).length);
  log('  reply found         : ' + report.turns.filter((t) => t.assistantMessage !== null).length);
  log('  uuids on the wire   : ' + report.uuidTotal);
  log('  uuids found in DOM  : ' + report.uuidWithDomAnchor);
  log('  api calls recorded  : ' + report.net.length);
  log('  transcript rows     : ' + (report.transcript?.length ?? 0));
  log('  websockets opened   : ' + (report.sockets?.length ?? 0));
  const frames = (report.sockets ?? []).reduce((n, s2) => n + s2.framesOut, 0);
  log('  websocket out frames: ' + frames);
  log('  uuid overlap        : ' + JSON.stringify(report.uuidOverlap));
  if (report.warnings.length > 0) {
    log('  warnings:');
    for (const w of report.warnings) log('    - ' + w);
  }
}

main().catch((e) => {
  console.error('[probe] failed:', e);
  process.exit(1);
});
