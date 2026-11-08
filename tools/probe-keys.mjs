/**
 * Decide whether `data-turn-key` can be the node id of the tree.
 *
 * The extension stores a tree of ids. If the page gives a message a fresh
 * id on every load, every stored tree breaks on the next visit. So this
 * test reads the keys, reloads the page, and reads them again.
 *
 * It also checks whether the reply key is the question key plus a suffix.
 * If it is, one id names one exchange, which is exactly what the tree needs.
 *
 * Usage:  pnpm probe:keys
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, cdpVersion, findPage } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '.probe-output');
const PORT = Number(process.env.CDP_PORT ?? 9222);
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const READ = `JSON.stringify({
  path: location.pathname,
  rows: Array.from(document.querySelectorAll('[data-testid="transcript-row"]')).map((row) => {
    let keyEl = row.hasAttribute('data-turn-key') ? row : row.querySelector('[data-turn-key]');
    if (keyEl === null) keyEl = row.closest('[data-turn-key]');
    return {
      role: row.getAttribute('data-perf-row'),
      index: row.getAttribute('data-index'),
      turnKey: keyEl === null ? null : keyEl.getAttribute('data-turn-key'),
      textLength: (row.innerText || '').trim().length,
    };
  }),
})`;

function log(...p) { console.log('[keys]', ...p); }

/** Replace each uuid with a short stable alias, so no real id is printed. */
function alias(map, value) {
  if (value === null) return null;
  return String(value).replace(UUID_ANY, (u) => {
    if (!map.has(u)) map.set(u, 'U' + (map.size + 1));
    return map.get(u);
  });
}

async function readRows(cdp, sessionId) {
  const raw = await cdp.evaluate(READ, { sessionId });
  return JSON.parse(raw ?? '{"rows":[]}');
}

async function waitRows(cdp, sessionId, minimum, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readRows(cdp, sessionId);
    if (state.rows.length >= minimum) return state;
    await new Promise((r) => setTimeout(r, 500));
  }
  return readRows(cdp, sessionId);
}

async function main() {
  const version = await cdpVersion(PORT);
  const target = await findPage(/claude\.ai\/chat\//, PORT)
    ?? await findPage('claude.ai', PORT);
  if (target === null) throw new Error('no claude.ai tab is open');

  const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  log('Chrome:', version.Browser);

  const first = await waitRows(cdp, undefined, 1);
  if (!/\/chat\//.test(first.path)) {
    throw new Error('the tab is not on a conversation. Run pnpm probe first, then this.');
  }
  log(`before the reload: ${first.rows.length} row(s)`);

  log('reloading the page ...');
  await cdp.send('Page.reload', { ignoreCache: false });
  await new Promise((r) => setTimeout(r, 4000));
  const second = await waitRows(cdp, undefined, first.rows.length);
  log(`after the reload : ${second.rows.length} row(s)`);

  // Compare by position, because the order of the list is the order of time.
  const map = new Map();
  const comparison = [];
  const count = Math.max(first.rows.length, second.rows.length);
  for (let i = 0; i < count; i++) {
    const a = first.rows[i] ?? null;
    const b = second.rows[i] ?? null;
    comparison.push({
      position: i,
      role: a?.role ?? b?.role ?? null,
      keyBefore: alias(map, a?.turnKey ?? null),
      keyAfter: alias(map, b?.turnKey ?? null),
      same: a !== null && b !== null && a.turnKey === b.turnKey,
    });
  }

  const stable = comparison.length > 0 && comparison.every((c) => c.same);

  // Does the reply key repeat the question key?
  const pairs = [];
  for (let i = 0; i + 1 < second.rows.length; i += 2) {
    const q = second.rows[i];
    const a = second.rows[i + 1];
    const qUuid = (q.turnKey ?? '').match(UUID_ANY)?.[0] ?? null;
    const aUuid = (a.turnKey ?? '').match(UUID_ANY)?.[0] ?? null;
    pairs.push({
      questionRole: q.role,
      replyRole: a.role,
      questionKey: alias(map, q.turnKey),
      replyKey: alias(map, a.turnKey),
      sharesOneUuid: qUuid !== null && qUuid === aUuid,
    });
  }
  const oneIdPerTurn = pairs.length > 0 && pairs.every((p) => p.sharesOneUuid);

  const report = {
    probedAt: new Date().toISOString(),
    rowsBefore: first.rows.length,
    rowsAfter: second.rows.length,
    keySurvivesReload: stable,
    oneIdPerExchange: oneIdPerTurn,
    comparison,
    pairs,
    distinctUuids: map.size,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'keys-latest.json'), JSON.stringify(report, null, 2));
  cdp.close();

  log('');
  log('rows before / after      : ' + first.rows.length + ' / ' + second.rows.length);
  log('key survives the reload  : ' + (stable ? 'YES' : 'NO'));
  log('one id per exchange      : ' + (oneIdPerTurn ? 'YES' : 'NO'));
  log('');
  for (const c of comparison) {
    log(`  pos ${c.position} ${String(c.role).padEnd(9)} ${c.keyBefore} -> ${c.keyAfter}  ${c.same ? 'same' : 'CHANGED'}`);
  }
  log('');
  log('wrote .probe-output/keys-latest.json');
}

main().catch((e) => {
  console.error('[keys] failed:', e);
  process.exit(1);
});
