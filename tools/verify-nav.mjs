/**
 * Check what only a long conversation can show.
 *
 *   1. Scrolling back through a long conversation must put every exchange
 *      it draws into the tree, and must give none of them a parent.
 *   2. A jump must reach an exchange that claude.ai has not drawn yet, and
 *      bring it into view.
 *
 * Moving between conversations is checked by `pnpm verify`, which runs in
 * a fraction of the time. This suite is the slow one: run it when the
 * adapter or the sweep changed, not on every edit.
 *
 * It reads and scrolls conversations that already exist. It sends nothing.
 *
 * Usage:
 *   pnpm build && pnpm verify:long
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, cdpVersion, findPage } from './cdp.mjs';
import { registerBundle, waitForPanel } from './inject-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '.probe-output');
const PORT = Number(process.env.CDP_PORT ?? 9222);

const failures = [];
function log(...p) { console.log('[nav]', ...p); }
function check(name, passed, detail) {
  if (passed) log(`  PASS  ${name}`);
  else {
    log(`  FAIL  ${name}${detail === undefined ? '' : ' -- ' + detail}`);
    failures.push(name + (detail === undefined ? '' : ': ' + detail));
  }
}

const READ = `JSON.stringify((() => {
  const host = document.getElementById('claude-tree-panel-host');
  const root = host === null ? null : host.shadowRoot;
  const rows = root === null ? [] : Array.from(root.querySelectorAll('.panel .row')).map((row) => ({
    // Read the structure the panel states, not the columns it draws. The
    // panel indents only where the conversation splits, so a column count
    // says nothing about how many roots the tree has.
    turn: row.dataset.turn,
    depth: Number(row.dataset.depth),
    indent: Number(row.dataset.indent),
    isRoot: row.dataset.root === 'true',
    columns: row.querySelectorAll('.g').length + (row.querySelector('.elbow') === null ? 0 : 1),
    label: (row.querySelector('.jump .text') || {}).textContent || '',
  }));
  const convEl = document.querySelector('[data-conv-id]');
  const trRows = Array.from(document.querySelectorAll('[data-testid="transcript-row"]'));
  // The exchanges the page shows right now, by id. One exchange is not
  // always two rows: a reply that carries a card or a tool result takes
  // more, so counting messages and halving it proves nothing.
  const turnsOnPage = [...new Set(trRows.map((r) => {
    const el = r.querySelector('[data-turn-key]') || r.closest('[data-turn-key]');
    if (el === null) return null;
    return (el.getAttribute('data-turn-key') || '').replace('-hub-reply', '');
  }).filter((x) => x !== null))];
  const indexes = trRows.map((r) => Number(r.getAttribute('data-index'))).filter((n) => !Number.isNaN(n));
  const article = document.querySelector('[data-testid="transcript-row"] [role="article"][aria-setsize]');
  const sc = document.querySelector('[data-autoscroll-container="true"]');
  return {
    urlId: (location.pathname.match(/\\/chat\\/([0-9a-f-]{36})/i) || [])[1] || null,
    convId: convEl === null ? null : convEl.getAttribute('data-conv-id'),
    domRows: trRows.length,
    minIndex: indexes.length ? Math.min.apply(null, indexes) : null,
    maxIndex: indexes.length ? Math.max.apply(null, indexes) : null,
    total: article === null ? null : Number(article.getAttribute('aria-setsize')),
    scrollTop: sc === null ? null : Math.round(sc.scrollTop),
    panelRows: rows,
    turnsOnPage,
    roots: rows.filter((r) => r.isRoot).length,
    notice: (() => {
      const n = root === null ? null : root.querySelector('.panel .notice');
      if (n === null || n.hidden) return null;
      // Read the text only. The strip also holds the load button.
      const text = n.querySelector('.noticetext');
      return text === null ? n.textContent : text.textContent;
    })(),
  };
})())`;

async function read(cdp) {
  return JSON.parse(await cdp.evaluate(READ) ?? '{}');
}

async function openSidebarLink(cdp, position) {
  return cdp.evaluate(`(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/chat/"]'));
    if (links[${position}] === undefined) return null;
    const href = links[${position}].getAttribute('href');
    links[${position}].click();
    return href;
  })()`);
}

async function settle(cdp, ms) {
  await new Promise((r) => setTimeout(r, ms));
  return read(cdp);
}

async function main() {
  const version = await cdpVersion(PORT);
  log('Chrome:', version.Browser);

  const target = await findPage('claude.ai', PORT);
  if (target === null) throw new Error('no claude.ai tab is open. Run tools/dev-chrome.sh first.');
  const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  log('injecting the built bundle for this session');
  if (!(await registerBundle(cdp))) throw new Error('the bundle did not mount. Run: pnpm build');

  // Moving between conversations is checked by `pnpm verify`, which is
  // far quicker. This suite covers only what needs a long conversation.
  // ---------------------------------------------------- faults 2 and 3
  log('');
  log('faults 2 and 3: a long conversation that loads a piece at a time');

  let longOne = null;
  // The first conversation with more than one screen of history is enough
  // to show lazy loading. Hunting for the longest one only made the run
  // slower, and taught nothing extra.
  for (const position of [0, 2, 4, 6, 8, 10, 12]) {
    await openSidebarLink(cdp, position);
    const s = await settle(cdp, 4000);
    if (s.total !== null && s.total >= 12) { longOne = s; break; }
  }
  if (longOne === null) {
    log('  SKIP  no conversation with 12 or more messages in the sidebar');
  } else {
    log(`  holds ${longOne.total} messages; ${longOne.domRows} rows drawn`);
    check(
      'the panel warns that older exchanges may be missing',
      longOne.notice !== null && /older exchanges/.test(longOne.notice),
      `notice: ${JSON.stringify(longOne.notice)}`,
    );

    // Open the panel and press the button that pulls in the whole history.
    await cdp.evaluate(`(() => {
      const root = document.getElementById('claude-tree-panel-host').shadowRoot;
      const panel = root.querySelector('.panel');
      if (!panel.classList.contains('open')) root.querySelector('.toggle').click();
      return true;
    })()`);
    await settle(cdp, 400);

    const hasButton = await cdp.evaluate(`(() => {
      const root = document.getElementById('claude-tree-panel-host').shadowRoot;
      const button = root.querySelector('.loadolder');
      if (button === null || button.hidden) return false;
      button.click();
      return true;
    })()`);
    check('the panel offers to read the whole conversation', hasButton === true);

    log('  sweeping the whole conversation (up, then back down) ...');
    // Remember every exchange the page really showed. An exchange can sit
    // in the tree and be gone from the conversation, because claude.ai
    // gives a message a new id when you edit or retry it.
    const everShown = new Set(longOne.turnsOnPage ?? []);
    let s = longOne;
    const rootCounts = [];
    for (let i = 0; i < 220; i++) {
      s = await settle(cdp, 1000);
      for (const id of s.turnsOnPage ?? []) everShown.add(id);
      rootCounts.push(s.roots);
      if (s.notice === null) break;
    }
    log(`  now holds ${s.total} messages, ${s.panelRows.length} exchanges in the tree`);
    log(`  roots while it loaded: ${[...new Set(rootCounts)].join(',')}`);

    check('the sweep finished', s.notice === null, `notice: ${JSON.stringify(s.notice)}`);
    check(
      'every exchange stands on its own until you link one',
      s.roots === s.panelRows.length,
      `${s.roots} roots for ${s.panelRows.length} rows`,
    );
    const inTree = new Set(s.panelRows.map((r) => r.turn));
    const missing = (s.turnsOnPage ?? []).filter((id) => !inTree.has(id));
    check(
      'the tree holds every exchange the page shows',
      missing.length === 0,
      `${missing.length} of ${(s.turnsOnPage ?? []).length} shown exchanges are absent`,
    );
    check(
      'the sweep found more than the first screen held',
      s.panelRows.length >= (longOne.turnsOnPage ?? []).length,
      `${s.panelRows.length} exchanges now, ${(longOne.turnsOnPage ?? []).length} at the start`,
    );
    check(
      'nothing indents while nothing is linked',
      s.panelRows.every((r) => r.columns === 0),
      `columns seen: ${[...new Set(s.panelRows.map((r) => r.columns))].join(',')}`,
    );
    check(
      'no exchange has a parent the extension gave it',
      s.panelRows.every((r) => r.depth === 0),
      `depths seen: ${[...new Set(s.panelRows.map((r) => r.depth))].join(',')}`,
    );

    // Fault 3: go to the end, then jump back to the first exchange.
    await cdp.evaluate(`(() => {
      const sc = document.querySelector('[data-autoscroll-container="true"]');
      if (sc !== null) sc.scrollTop = sc.scrollHeight;
      return true;
    })()`);
    await settle(cdp, 2500);

    // Jump to the oldest exchange that the page really showed. Match on the
    // id, never on the label: the label has its blank space collapsed, so
    // it does not always appear in the page word for word.
    const reachable = s.panelRows.filter((r) => everShown.has(r.turn));
    const firstTurn = reachable[0]?.turn ?? '';
    log(`  ${reachable.length} of ${s.panelRows.length} exchanges were seen on the page`);
    if (reachable.length < s.panelRows.length) {
      log('  (the rest are in the tree but not in the conversation any more)');
    }
    // Click the row we are about to look for, by its id. Clicking row
    // zero and then looking for another row proved nothing.
    const clicked = await cdp.evaluate(`(() => {
      const root = document.getElementById('claude-tree-panel-host').shadowRoot;
      const panel = root.querySelector('.panel');
      if (!panel.classList.contains('open')) root.querySelector('.toggle').click();
      const row = root.querySelector('.panel .row[data-turn="' + ${JSON.stringify(firstTurn)} + '"]');
      if (row === null) return 'no such row';
      row.querySelector('.jump').click();
      return 'clicked';
    })()`);
    check('the panel row to jump from is there', clicked === 'clicked', String(clicked));
    await new Promise((r) => setTimeout(r, 2000));
    const started = await read(cdp);
    log(`    two seconds in: notice ${JSON.stringify(started.notice)}, busy ${started.busy || '-'}`);

    // The jump has its own settle loop, and from the end of a long chat it
    // must scroll past every message and wait for each batch to load. Give
    // it far more room than it needs, or a slow run looks like a fault.
    let landed = null;
    let lastNotice = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      landed = JSON.parse(await cdp.evaluate(`JSON.stringify((() => {
        const wanted = ${JSON.stringify(firstTurn)};
        const rows = Array.from(document.querySelectorAll('[data-testid="transcript-row"]'));
        const target = rows.find((r) => {
          const el = r.querySelector('[data-turn-key]') || r.closest('[data-turn-key]');
          if (el === null) return false;
          const key = el.getAttribute('data-turn-key') || '';
          return key.replace('-hub-reply', '') === wanted;
        }) || null;
        const sc = document.querySelector('[data-autoscroll-container="true"]');
        if (target === null || sc === null) return { present: false };
        const box = target.getBoundingClientRect();
        const middle = sc.getBoundingClientRect().top + sc.clientHeight / 2;
        const view = sc.getBoundingClientRect();
        return {
          present: true,
          offCentre: Math.round(Math.abs(box.top + box.height / 2 - middle)),
          viewportHeight: Math.round(sc.clientHeight),
          // An exchange at either end of the chat cannot be centred: the
          // view is already against the stop. The thing that matters is
          // that the reader can see it.
          visible: box.bottom > view.top + 8 && box.top < view.bottom - 8,
          atTop: sc.scrollTop <= 2,
          atBottom: sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2,
        };
      })())`) ?? '{}');
      const state = await read(cdp);
      lastNotice = state.notice;
      if (landed.present === true && state.notice === null) break;
      if (i % 10 === 9) {
        log(`    still looking after ${i + 1}s: on page ${landed.present === true}`
          + `, rows ${state.domRows}, scrollTop ${state.scrollTop}`);
      }
    }

    check('the jump found the first exchange', landed?.present === true,
      `wanted ${String(firstTurn).slice(0, 8)}, last notice ${JSON.stringify(lastNotice)}`);
    check(
      'the jump brought it into view',
      landed?.visible === true,
      `off centre by ${landed?.offCentre}px, view ${landed?.viewportHeight}px`,
    );
    // Centring is only possible away from the two stops.
    const againstAStop = landed?.atTop === true || landed?.atBottom === true;
    check(
      againstAStop
        ? 'it sits as close to the middle as the end of the chat allows'
        : 'the jump put it near the middle of the view',
      againstAStop
        ? landed?.visible === true
        : landed?.present === true && landed.offCentre < Math.max(220, landed.viewportHeight / 3),
      `off centre by ${landed?.offCentre}px, at a stop: ${againstAStop}`,
    );

    try {
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(join(OUT_DIR, 'verify-nav-after-jump.png'), await cdp.screenshot());
    } catch { /* a missing picture is not a failure */ }
  }

  cdp.close();
  log('');
  if (failures.length === 0) {
    log('ALL CHECKS PASSED');
  } else {
    log(`${failures.length} CHECK(S) FAILED`);
    for (const f of failures) log('  - ' + f);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[nav] failed:', e);
  process.exit(1);
});
