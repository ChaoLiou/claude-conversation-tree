/**
 * Find out how claude.ai really sends a message.
 *
 * The page level hooks in probe-core.js saw nothing, because the request
 * does not come from the page's own JavaScript context. This driver asks
 * Chrome itself instead. It attaches to the browser target, turns on
 * automatic attach, and enables the Network domain on every child target:
 * the page, each iframe, each worker, and the service worker.
 *
 * Nothing is injected into the page, so claude.ai runs untouched.
 *
 * PRIVACY
 *   It records no request body text. A JSON body becomes a map of field
 *   names to value types, the same shaping the page probe uses.
 *
 * Usage:
 *   pnpm probe:net
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, cdpVersion, findPage } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '.probe-output');
const PORT = Number(process.env.CDP_PORT ?? 9222);
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID_ONE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const token = 'ZNET' + Math.random().toString(36).slice(2, 7).toUpperCase();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

function log(...parts) {
  console.log('[net]', ...parts);
}

/** Describe a value without keeping its content. */
function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) {
    if (depth > 5) return 'array';
    return { __array: v.length, __item: v.length ? shape(v[0], depth + 1) : null };
  }
  if (typeof v === 'object') {
    if (depth > 5) return 'object';
    const o = {};
    for (const k of Object.keys(v).slice(0, 60)) o[k] = shape(v[k], depth + 1);
    return o;
  }
  if (typeof v === 'string') {
    if (UUID_ONE.test(v)) return 'uuid';
    if (v.length <= 24 && /^[\w .:+/@-]*$/.test(v)) return 'short:' + v;
    return `string(${v.length})`;
  }
  return typeof v;
}

function maskPath(url) {
  try {
    const u = new URL(url);
    const keys = [...u.searchParams.keys()];
    return u.pathname.replace(UUID_ANY, '<uuid>') + (keys.length ? '?' + keys.join('&') : '');
  } catch {
    return String(url).slice(0, 120).replace(UUID_ANY, '<uuid>');
  }
}

function collectUuids(value, into) {
  if (typeof value === 'string') {
    const hits = value.match(UUID_ANY);
    if (hits) for (const u of hits) into.add(u);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const v of Object.values(value)) collectUuids(v, into);
}

async function main() {
  const version = await cdpVersion(PORT);
  log('Chrome:', version.Browser);

  // Attach to the browser target, not a page. This is what lets us see a
  // worker's traffic.
  const browser = await Cdp.attach(version.webSocketDebuggerUrl);
  log('attached to the browser target');

  const sessions = new Map(); // sessionId -> target info
  const requests = new Map(); // requestId -> record
  const ordered = [];
  const uuids = new Set();

  browser.on('Target.attachedToTarget', async (p, parentSessionId) => {
    const info = p.targetInfo;
    sessions.set(p.sessionId, { type: info.type, url: info.url, title: info.title });
    void parentSessionId;
    try {
      await browser.send('Network.enable', { maxPostDataSize: 65536 }, p.sessionId);
      // Keep digging: a page can own workers of its own.
      await browser.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      }, p.sessionId);
      await browser.send('Runtime.runIfWaitingForDebugger', {}, p.sessionId).catch(() => {});
    } catch (e) {
      log(`could not watch the ${info.type} target: ${String(e.message || e)}`);
    }
  });

  browser.on('Network.requestWillBeSent', (p, sessionId) => {
    const url = p.request.url;
    if (!url.startsWith('http')) return;
    // Skip static files and telemetry only. Never filter on a guessed path,
    // because the send may not live under /api/ at all.
    if (/\.(js|mjs|css|png|jpe?g|webp|avif|gif|svg|woff2?|ttf|ico|map|wasm)(\?|$)/i.test(url)) return;
    if (/datadog|datadoghq|sentry|segment|statsig|posthog|amplitude|google-analytics|googletagmanager|cloudflareinsights/i.test(url)) return;
    if (/\/rum\b|\/v2\/rum|event_logging/.test(url)) return;

    const where = sessions.get(sessionId) ?? { type: 'unknown', url: '' };
    let host = '';
    try { host = new URL(url).host; } catch { host = '?'; }
    const rec = {
      realm: where.type,
      realmUrl: maskPath(where.url),
      method: p.request.method,
      host,
      path: maskPath(url),
      initiator: p.initiator?.type ?? '?',
      hasPostData: Boolean(p.request.hasPostData),
      requestShape: undefined,
      responseStatus: undefined,
      responseMimeType: undefined,
      responseShape: undefined,
      sessionId,
      requestId: p.requestId,
    };
    collectUuids(url, uuids);

    const inline = p.request.postData;
    if (typeof inline === 'string') {
      try {
        const parsed = JSON.parse(inline);
        collectUuids(parsed, uuids);
        rec.requestShape = shape(parsed);
      } catch {
        rec.requestShape = `non-json(${inline.length})`;
      }
    }

    requests.set(p.requestId, rec);
    ordered.push(rec);
  });

  browser.on('Network.responseReceived', (p) => {
    const rec = requests.get(p.requestId);
    if (!rec) return;
    rec.responseStatus = p.response.status;
    rec.responseMimeType = p.response.mimeType;
  });

  // Turn on automatic attach for everything the browser owns.
  await browser.send('Target.setDiscoverTargets', { discover: true });
  await browser.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  log('watching every target for network traffic');
  await new Promise((r) => setTimeout(r, 1500));

  // Find the claude.ai page session, so we can type into it.
  let pageSessionId = null;
  for (const [sid, info] of sessions) {
    if (info.type === 'page' && info.url.includes('claude.ai')) pageSessionId = sid;
  }
  if (pageSessionId === null) {
    const target = await findPage('claude.ai', PORT);
    if (target === null) throw new Error('no claude.ai tab is open');
    const res = await browser.send('Target.attachToTarget', { targetId: target.id, flatten: true });
    pageSessionId = res.sessionId;
    sessions.set(pageSessionId, { type: 'page', url: target.url, title: target.title });
    await browser.send('Network.enable', { maxPostDataSize: 65536 }, pageSessionId);
  }
  log('page session:', pageSessionId);

  await browser.send('Page.enable', {}, pageSessionId);
  await browser.send('Runtime.enable', {}, pageSessionId);

  // Start a fresh conversation.
  await browser.send('Page.navigate', { url: 'https://claude.ai/new' }, pageSessionId);
  await new Promise((r) => setTimeout(r, 4000));

  const findComposer = `(() => {
    for (const sel of ['div[contenteditable="true"]', 'textarea', '[role="textbox"]']) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width > 120 && r.height > 16) { el.focus(); return true; }
      }
    }
    return false;
  })()`;

  let focused = false;
  for (let i = 0; i < 40; i++) {
    focused = await browser.evaluate(findComposer, { sessionId: pageSessionId });
    if (focused) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!focused) throw new Error('the message box never appeared, or it would not take focus');
  log('message box focused');

  // Mark the boundary, so the send stands out in the log.
  const before = ordered.length;

  const text = `${token} reply with only: OK`;
  log('sending one marker message');
  await browser.send('Input.insertText', { text }, pageSessionId);
  await new Promise((r) => setTimeout(r, 400));
  await browser.send('Input.dispatchKeyEvent', {
    type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r',
  }, pageSessionId);
  await browser.send('Input.dispatchKeyEvent', {
    type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter',
  }, pageSessionId);

  await new Promise((r) => setTimeout(r, 12000));

  // Read the turn keys the page now shows, to match them to the wire.
  const turnKeys = await browser.evaluate(`JSON.stringify(
    Array.from(document.querySelectorAll('[data-turn-key]')).map((el) => el.getAttribute('data-turn-key'))
  )`, { sessionId: pageSessionId });
  const domKeys = JSON.parse(turnKeys ?? '[]');

  const pageState = JSON.parse(await browser.evaluate(`JSON.stringify({
    rows: document.querySelectorAll('[data-testid="transcript-row"]').length,
    markerOnPage: (document.body.innerText || '').includes(${JSON.stringify(token)}),
    path: location.pathname.replace(/[0-9a-f-]{36}/gi, '<uuid>'),
    composerEmpty: (() => {
      for (const sel of ['div[contenteditable="true"]', 'textarea']) {
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width > 120 && r.height > 16) return (el.innerText || el.value || '').trim() === '';
        }
      }
      return null;
    })(),
  })`, { sessionId: pageSessionId }) ?? '{}');
  const domUuids = new Set();
  for (const k of domKeys) collectUuids(String(k), domUuids);

  let inBoth = 0;
  for (const u of domUuids) if (uuids.has(u)) inBoth++;

  const afterSend = ordered.slice(before);

  const report = {
    probedAt: new Date().toISOString(),
    realmsSeen: [...new Set([...sessions.values()].map((s) => s.type))],
    targetCount: sessions.size,
    apiCallsTotal: ordered.length,
    apiCallsAfterSend: afterSend.length,
    callsAfterSend: afterSend.map(({ sessionId, requestId, ...rest }) => {
      void sessionId; void requestId;
      return rest;
    }),
    turnKeyFormats: domKeys.map((k) => String(k).replace(UUID_ANY, '<uuid>')),
    pageState,
    hostsSeen: [...new Set(ordered.map((r) => r.host))],
    uuidMatch: { inDom: domUuids.size, onWire: uuids.size, inBoth },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `net-${stamp}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT_DIR, 'net-latest.json'), JSON.stringify(report, null, 2));

  browser.close();

  log('');
  log('realms attached     : ' + report.realmsSeen.join(', '));
  log('targets attached    : ' + report.targetCount);
  log('api calls total     : ' + report.apiCallsTotal);
  log('api calls after send: ' + report.apiCallsAfterSend);
  log('uuid match          : ' + JSON.stringify(report.uuidMatch));
  log('page state          : ' + JSON.stringify(report.pageState));
  log('hosts seen          : ' + report.hostsSeen.join(', '));
  log('');
  log('calls after the send:');
  for (const c of report.callsAfterSend) {
    log(`  [${c.realm}/${c.initiator}] ${c.method} ${c.responseStatus ?? '-'} ${c.host}${c.path}`);
  }
  log('');
  log('wrote .probe-output/net-latest.json');
}

main().catch((e) => {
  console.error('[net] failed:', e);
  process.exit(1);
});
