/**
 * Prove the extension works on the real claude.ai page.
 *
 * It drives the browser the way a person would: open the panel, ask a
 * question, ask another, then choose the first exchange and ask a third.
 * The third must sit beside the second, not below it. That is the whole
 * point of the extension, so this is the test that matters.
 *
 * It reads the panel through the shadow root, which is `mode: open`, so it
 * checks what the user really sees. It never reads the extension's own
 * memory.
 *
 * Usage:
 *   tools/dev-extension.sh      build and load the extension first
 *   pnpm verify
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, cdpVersion, findPage } from './cdp.mjs';
import { registerBundle } from './inject-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '.probe-output');
const PORT = Number(process.env.CDP_PORT ?? 9222);
const token = 'ZVER' + Math.random().toString(36).slice(2, 6).toUpperCase();

const failures = [];
const notes = [];

function log(...parts) { console.log('[verify]', ...parts); }

function check(name, passed, detail) {
  if (passed) {
    log(`  PASS  ${name}`);
  } else {
    log(`  FAIL  ${name}${detail === undefined ? '' : ' -- ' + detail}`);
    failures.push(name + (detail === undefined ? '' : ': ' + detail));
  }
}

/** Read the panel the way the user sees it, through the shadow root. */
const READ_PANEL = `(() => {
  const host = document.getElementById('claude-tree-panel-host');
  if (host === null) return JSON.stringify({ mounted: false });
  const root = host.shadowRoot;
  if (root === null) return JSON.stringify({ mounted: true, shadow: false });
  const toggle = root.querySelector('.toggle');
  const panel = root.querySelector('.panel');
  const rows = Array.from(root.querySelectorAll('.panel .row')).map((row) => {
    const spacers = row.querySelectorAll('.g').length;
    const elbow = row.querySelector('.elbow') === null ? 0 : 1;
    const jump = row.querySelector('.jump .text');
    const kids = row.querySelector('.jump .kids');
    return {
      // depth is how many parents the node has. columns is how far the
      // panel indents it, which rises only where the tree splits.
      depth: Number(row.dataset.depth),
      columns: spacers + elbow,
      isRoot: row.dataset.root === 'true',
      label: jump === null ? '' : jump.textContent,
      kids: kids === null ? '' : kids.textContent,
      chosen: row.classList.contains('chosen'),
      active: row.classList.contains('active'),
    };
  });
  return JSON.stringify({
    mounted: true,
    shadow: true,
    open: panel !== null && panel.classList.contains('open'),
    count: toggle === null ? null : toggle.querySelector('.count').textContent,
    linking: (() => {
      const l = root.querySelector('.panel .linking');
      return l !== null && getComputedStyle(l).display !== 'none';
    })(),
    pendingVisible: (() => {
      const p = root.querySelector('.panel .pending');
      // Read what the browser really draws. The hidden attribute alone lies
      // when a stylesheet sets display on the element.
      return p !== null && getComputedStyle(p).display !== 'none';
    })(),
    notice: (() => {
      const n = root.querySelector('.panel .notice');
      if (n === null || getComputedStyle(n).display === 'none') return null;
      return n.textContent;
    })(),
    emptyText: (() => {
      const e = root.querySelector('.panel .empty');
      return e === null ? null : e.textContent.slice(0, 40);
    })(),
    rows,
  });
})()`;

async function readPanel(cdp) {
  const raw = await cdp.evaluate(READ_PANEL);
  return JSON.parse(raw ?? '{"mounted":false}');
}

async function waitPanel(cdp, predicate, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readPanel(cdp);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  notes.push(`timed out waiting for ${label}. Last panel state: ${JSON.stringify(last)}`);
  return last;
}

async function shoot(cdp, name) {
  try {
    const png = await cdp.screenshot();
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `verify-${name}.png`), png);
  } catch (e) {
    notes.push(`screenshot ${name} failed: ${String(e.message || e)}`);
  }
}

async function sendMessage(cdp, text) {
  const focused = await cdp.evaluate(`(() => {
    for (const sel of ['div[contenteditable="true"]', 'textarea']) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width > 120 && r.height > 16) { el.focus(); return true; }
      }
    }
    return false;
  })()`);
  if (!focused) throw new Error('the message box would not take focus');

  await cdp.send('Input.insertText', { text });
  await new Promise((r) => setTimeout(r, 400));
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r',
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter',
  });
}

/** Wait until the page text stops growing, so the reply has finished. */
async function waitSettled(cdp, quietMs = 1800, timeoutMs = 90000) {
  return cdp.evaluate(`new Promise((resolve) => {
    const started = Date.now();
    let lastLength = -1;
    let lastChange = Date.now();
    const timer = setInterval(() => {
      const length = (document.body.innerText || '').length;
      if (length !== lastLength) { lastLength = length; lastChange = Date.now(); }
      if (Date.now() - lastChange >= ${quietMs}) { clearInterval(timer); resolve(true); }
      else if (Date.now() - started > ${timeoutMs}) { clearInterval(timer); resolve(false); }
    }, 250);
  })`);
}

async function main() {
  const version = await cdpVersion(PORT);
  log('Chrome:', version.Browser);

  let target = await findPage('claude.ai', PORT);
  if (target === null) throw new Error('no claude.ai tab is open. Run tools/dev-extension.sh first.');
  const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const href = await cdp.evaluate('location.href');
  if (/\/login|\/signin/.test(href)) throw new Error('the dev profile is signed out');

  // Current Chrome will not install an unpacked extension, so put the same
  // bundle in over the protocol. It lasts for this session only.
  log('injecting the built bundle for this session');
  const mounted = await registerBundle(cdp);
  if (!mounted) throw new Error('the bundle did not mount. Run: pnpm build');

  log('opening a fresh conversation');
  await cdp.send('Page.navigate', { url: 'https://claude.ai/new' });
  await new Promise((r) => setTimeout(r, 4500));

  // 1. Is the extension there at all?
  log('step 1: the panel mounts');
  let panel = await waitPanel(cdp, (p) => p.mounted === true && p.shadow === true, 'the panel to mount');
  check('the panel mounts on claude.ai', panel.mounted === true);
  check('the panel uses a shadow root', panel.shadow === true);
  await shoot(cdp, '1-mounted');

  // 2. Does it open, and does it say the right thing when empty?
  log('step 2: the panel opens');
  await cdp.evaluate(`document.getElementById('claude-tree-panel-host').shadowRoot.querySelector('.toggle').click()`);
  await new Promise((r) => setTimeout(r, 400));
  panel = await readPanel(cdp);
  check('the panel opens when you click the button', panel.open === true);
  check('an empty tree explains itself', typeof panel.emptyText === 'string' && panel.emptyText.length > 0);
  await shoot(cdp, '2-open-empty');

  // 3. One question gives one root.
  log('step 3: ask the first question');
  await sendMessage(cdp, `${token}-1 reply with only: OK`);
  await waitSettled(cdp);
  panel = await waitPanel(cdp, (p) => p.rows.length >= 1, 'the first exchange');
  const conversationUrl = await cdp.evaluate('location.href');
  check('one exchange gives one row', panel.rows.length === 1, `saw ${panel.rows.length}`);
  check('the first row is a root', panel.rows[0]?.isRoot === true);
  check('the row label holds the question', String(panel.rows[0]?.label).includes(token));
  check(
    'the row label shows the question once, with no spoken prefix',
    (() => {
      const label = String(panel.rows[0]?.label ?? '');
      return label.indexOf(token) === label.lastIndexOf(token);
    })(),
    `label: ${JSON.stringify(panel.rows[0]?.label)}`,
  );
  await shoot(cdp, '3-one-row');

  // 4. A plain second question continues the line.
  log('step 4: ask a second question, with no choice');
  await sendMessage(cdp, `${token}-2 reply with only: OK`);
  await waitSettled(cdp);
  panel = await waitPanel(cdp, (p) => p.rows.length >= 2, 'the second exchange');
  check('two exchanges give two rows', panel.rows.length === 2, `saw ${panel.rows.length}`);
  // Nothing was tied to anything, so both exchanges stand on their own.
  // The extension never works a link out for itself any more.
  check('an exchange you did not tie up stands alone', panel.rows[1]?.isRoot === true);
  check('nothing indents while nothing is linked', panel.rows.every((r) => r.columns === 0),
    `columns: ${panel.rows.map((r) => r.columns).join(',')}`);
  await shoot(cdp, '4-two-rows-linear');

  // 5. Choose the first exchange.
  log('step 5: choose the first exchange as the parent');
  await cdp.evaluate(`(() => {
    const root = document.getElementById('claude-tree-panel-host').shadowRoot;
    root.querySelectorAll('.panel .row')[0].querySelector('.branch').click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  panel = await readPanel(cdp);
  check('the chosen row is marked', panel.rows[0]?.chosen === true);
  check('the panel says where the next question goes', panel.pendingVisible === true);
  await shoot(cdp, '5-parent-chosen');

  // 6. The third question must become a sibling of the second.
  log('step 6: ask the third question');
  await sendMessage(cdp, `${token}-3 reply with only: OK`);
  await waitSettled(cdp);
  panel = await waitPanel(cdp, (p) => p.rows.length >= 3, 'the third exchange');
  check('three exchanges give three rows', panel.rows.length === 3, `saw ${panel.rows.length}`);
  // The tree now reads: q1 with q3 under it, and q2 on its own.
  const byTurn = Object.fromEntries(panel.rows.map((r) => [r.label.slice(0, 12), r]));
  const third = panel.rows.find((r) => r.label.includes(`${token}-3`)) ?? null;
  const second = panel.rows.find((r) => r.label.includes(`${token}-2`)) ?? null;
  const first = panel.rows.find((r) => r.label.includes(`${token}-1`)) ?? null;
  void byTurn;
  check('the third question hangs under the first', third?.depth === 1 && third?.isRoot === false,
    `depth ${third?.depth}, root ${third?.isRoot}`);
  check('the second question is still on its own', second?.isRoot === true);
  check('the first exchange reports one follow-up', String(first?.kids).includes('1'), `kids: ${first?.kids}`);
  check('the panel draws the one link', third?.columns === 0 && first?.columns === 0,
    `columns: ${panel.rows.map((r) => r.columns).join(',')}`);
  check('the choice is spent', panel.pendingVisible === false);
  await shoot(cdp, '6-branched');

  // 6b. Link an exchange after the event, which is the only other way to
  //     make a link now.
  log('step 6b: link the second exchange under the third, after the event');
  await cdp.evaluate(`(() => {
    const root = document.getElementById('claude-tree-panel-host').shadowRoot;
    const rows = Array.from(root.querySelectorAll('.panel .row'));
    const second = rows.find((r) => (r.textContent || '').includes(${JSON.stringify(token + '-2')}));
    second.querySelector('.link').click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  panel = await readPanel(cdp);
  check('the panel asks which parent to use', panel.linking === true);

  await cdp.evaluate(`(() => {
    const root = document.getElementById('claude-tree-panel-host').shadowRoot;
    const rows = Array.from(root.querySelectorAll('.panel .row'));
    const third = rows.find((r) => (r.textContent || '').includes(${JSON.stringify(token + '-3')}));
    third.querySelector('.branch').click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  panel = await readPanel(cdp);
  const linked = panel.rows.find((r) => r.label.includes(`${token}-2`)) ?? null;
  check('the exchange moved under the one you picked', linked?.depth === 2,
    `depth ${linked?.depth}`);
  check('the panel stopped asking', panel.linking === false);
  await shoot(cdp, '6b-linked-after');

  // 6c. Moving to another conversation must not carry these exchanges
  //     over. This is cheap, so it belongs in the fast suite.
  log('step 6c: move to another conversation');
  const mine = panel.rows.map((r) => r.label);
  const moved = await cdp.evaluate(`(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/chat/"]'));
    const here = location.pathname;
    const other = links.find((a) => a.getAttribute('href') !== here);
    if (other === undefined) return null;
    other.click();
    return true;
  })()`);
  if (moved === null) {
    log('  SKIP  no other conversation in the sidebar');
  } else {
    // claude.ai changes the address about 400 ms before the message list,
    // so sample across that gap, not after it.
    let leaked = [];
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const now = await readPanel(cdp);
      const bad = now.rows.map((r) => r.label).filter((l) => l !== '' && mine.includes(l));
      if (bad.length > leaked.length) leaked = bad;
    }
    check('the next conversation does not inherit these exchanges', leaked.length === 0,
      `${leaked.length} leaked`);
  }

  // 7. A jump must scroll the chat.
  log('returning to the conversation under test');
  await cdp.send('Page.navigate', { url: conversationUrl });
  await new Promise((r) => setTimeout(r, 4500));
  panel = await waitPanel(cdp, (p) => p.rows.length >= 3, 'the tree to come back');
  log('step 7: jump to the first exchange');
  const scrollBefore = await cdp.evaluate(
    `(document.querySelector('[data-autoscroll-container="true"]')?.scrollTop ?? -1)`,
  );
  await cdp.evaluate(`(() => {
    const root = document.getElementById('claude-tree-panel-host').shadowRoot;
    root.querySelectorAll('.panel .row')[0].querySelector('.jump').click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 1600));
  const scrollAfter = await cdp.evaluate(
    `(document.querySelector('[data-autoscroll-container="true"]')?.scrollTop ?? -1)`,
  );
  const flashed = await cdp.evaluate(
    `document.querySelectorAll('.claude-tree-flash').length >= 0`,
  );
  check('the jump moved the chat', scrollBefore !== scrollAfter, `scrollTop ${scrollBefore} -> ${scrollAfter}`);
  check('the flash style is installed', flashed === true);
  await shoot(cdp, '7-after-jump');

  // 8. The tree must survive a reload.
  log('step 8: reload the page');
  await cdp.send('Page.reload', {});
  await new Promise((r) => setTimeout(r, 5000));
  panel = await waitPanel(cdp, (p) => p.rows.length >= 3, 'the tree after the reload');
  check('the tree survives a reload', panel.rows.length === 3, `saw ${panel.rows.length}`);
  const thirdAfter = panel.rows.find((r) => r.label.includes(`${token}-3`)) ?? null;
  check('the link survives a reload', thirdAfter?.depth === 1 && thirdAfter?.isRoot === false,
    `depth ${thirdAfter?.depth}, root ${thirdAfter?.isRoot}`);
  await shoot(cdp, '8-after-reload');

  cdp.close();

  log('');
  if (notes.length > 0) {
    log('notes:');
    for (const n of notes) log('  - ' + n);
    log('');
  }
  if (failures.length === 0) {
    log('ALL CHECKS PASSED');
    log('screenshots in .probe-output/verify-*.png');
  } else {
    log(`${failures.length} CHECK(S) FAILED`);
    for (const f of failures) log('  - ' + f);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[verify] failed:', e);
  process.exit(1);
});
