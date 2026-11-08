/**
 * The in-page half of the probe. Version 3.
 *
 * Two things load this file:
 *   - tools/probe-run.mjs, over the DevTools protocol. This is the normal way.
 *   - a paste into the DevTools console. This is the fallback.
 *
 * It installs network hooks, then waits. The driver calls its methods.
 * It never guesses a CSS selector. It finds an element by the text that the
 * driver just typed, and then reports what that element really is.
 *
 * PRIVACY
 *   It records no message text and no long string value. Every string
 *   becomes a type: "uuid", "short:<value>" or "string(<length>)".
 *   Field names survive, because the adapter needs them.
 */
(() => {
  'use strict';

  if (window.__probe !== undefined && window.__probe.__version === 3) return;

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  // Layout classes carry no meaning for the adapter. Drop them.
  const NOISE_CLASS = /^(-?(flex|grid|block|inline|contents|hidden|table|relative|absolute|fixed|sticky|static|isolate|overflow|truncate|whitespace|break|select|cursor|pointer|transition|duration|ease|delay|animate|transform|translate|scale|rotate|opacity|shadow|ring|outline|rounded|border|divide|bg|text|font|leading|tracking|antialiased|list|align|place|items|justify|self|content|order|col|row|gap|space|w|h|min|max|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|top|right|bottom|left|inset|z|basis|grow|shrink)([-:]|$))|^(sm|md|lg|xl|2xl|hover|focus|focus-visible|active|disabled|dark|group-hover|peer|first|last|odd|even|motion-safe|motion-reduce):/;

  const net = [];
  const uuidsSeen = new Set();

  // ------------------------------------------------------------- shaping

  function shape(v, depth) {
    depth = depth || 0;
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
      if (UUID.test(v)) { uuidsSeen.add(v); return 'uuid'; }
      if (v.length <= 24 && /^[\w .:+/@-]*$/.test(v)) return 'short:' + v;
      return 'string(' + v.length + ')';
    }
    return typeof v;
  }

  function collectUuids(value) {
    if (typeof value === 'string') {
      const found = value.match(UUID_ANY);
      if (found) for (const u of found) uuidsSeen.add(u);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const v of Object.values(value)) collectUuids(v);
  }

  function safePath(url) {
    try {
      const u = new URL(url, location.origin);
      const keys = Array.from(u.searchParams.keys());
      return u.pathname.replace(UUID_ANY, '<uuid>') + (keys.length ? '?' + keys.join('&') : '');
    } catch (e) {
      return String(url).slice(0, 90).replace(UUID_ANY, '<uuid>');
    }
  }

  function parseMaybeJson(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  // ---------------------------------------------------------- DOM report

  function attrsOf(el) {
    const o = {};
    for (const a of el.attributes) {
      if (a.name === 'class' || a.name === 'style') continue;
      o[a.name] = shape(a.value);
    }
    return o;
  }

  function meaningfulClasses(el) {
    const raw = el.getAttribute('class');
    if (!raw) return [];
    return raw.split(/\s+/).filter((c) => c !== '' && !NOISE_CLASS.test(c)).slice(0, 14);
  }

  function matchCount(selector) {
    try { return document.querySelectorAll(selector).length; } catch (e) { return -1; }
  }

  function selectorCandidates(el) {
    const raw = [];
    for (const a of el.attributes) {
      if (a.name === 'class' || a.name === 'style') continue;
      if (!/^(data-|aria-)/.test(a.name) && a.name !== 'role') continue;
      const useValue = a.value !== '' && a.value.length <= 30 && !UUID.test(a.value);
      raw.push(useValue ? '[' + a.name + '="' + a.value.replace(/"/g, '\\"') + '"]' : '[' + a.name + ']');
    }
    for (const c of meaningfulClasses(el)) {
      try { raw.push('.' + CSS.escape(c)); } catch (e) { /* unusable name */ }
    }
    const seen = new Set();
    const result = [];
    for (const s of raw) {
      if (seen.has(s)) continue;
      seen.add(s);
      const n = matchCount(s);
      if (n > 0 && n <= 500) result.push({ selector: s, matches: n });
    }
    return result.sort((a, b) => a.matches - b.matches);
  }

  function chainOf(startEl, levels) {
    const chain = [];
    let el = startEl;
    for (let i = 0; i < (levels || 12) && el !== null && el !== document.documentElement; i++) {
      chain.push({
        level: i,
        tag: el.tagName.toLowerCase(),
        attrs: attrsOf(el),
        classes: meaningfulClasses(el),
        textLength: (el.textContent || '').length,
        childCount: el.children.length,
        selectorCandidates: selectorCandidates(el),
      });
      el = el.parentElement;
    }
    return chain;
  }

  /**
   * The innermost elements that satisfy `predicate`.
   * An ancestor of a match is dropped, so only the tightest matches remain.
   */
  function tightest(predicate) {
    const all = Array.prototype.filter.call(document.querySelectorAll('*'), predicate);
    return all.filter((el) => !all.some((other) => other !== el && el.contains(other)));
  }

  function findByText(needle) {
    return tightest((el) => (el.textContent || '').indexOf(needle) >= 0);
  }

  function scrollContainerOf(el) {
    let s = el === null ? null : el.parentElement;
    for (let i = 0; i < 25 && s !== null; i++) {
      const st = getComputedStyle(s);
      if (/(auto|scroll)/.test(st.overflowY) && s.scrollHeight > s.clientHeight + 4) {
        return {
          levelsUp: i + 1,
          tag: s.tagName.toLowerCase(),
          attrs: attrsOf(s),
          classes: meaningfulClasses(s),
          selectorCandidates: selectorCandidates(s),
          overflowY: st.overflowY,
          scrollHeight: s.scrollHeight,
          clientHeight: s.clientHeight,
        };
      }
      s = s.parentElement;
    }
    return null;
  }

  /** Where does this uuid live in the DOM? This is how we anchor a node. */
  function findUuidInDom(uuid) {
    const hits = [];
    for (const el of document.querySelectorAll('*')) {
      for (const a of el.attributes) {
        if (a.value.indexOf(uuid) < 0) continue;
        hits.push({
          attribute: a.name,
          exactValue: a.value === uuid,
          tag: el.tagName.toLowerCase(),
          classes: meaningfulClasses(el),
          attributeSelectorMatches: matchCount('[' + a.name + ']'),
          textLength: (el.textContent || '').length,
        });
        if (hits.length >= 12) return hits;
      }
    }
    return hits;
  }

  // ------------------------------------------------------- page censuses

  function census() {
    const all = document.querySelectorAll('*');
    const attrMap = new Map();
    for (const el of all) {
      for (const a of el.attributes) {
        if (a.name.indexOf('data-') !== 0) continue;
        let e = attrMap.get(a.name);
        if (e === undefined) attrMap.set(a.name, (e = { name: a.name, count: 0, uuidValues: 0, distinct: new Set() }));
        e.count++;
        if (UUID.test(a.value)) e.uuidValues++;
        if (e.distinct.size < 6) e.distinct.add(a.value.length > 30 ? '<long:' + a.value.length + '>' : a.value);
      }
    }
    const attributes = Array.from(attrMap.values())
      .filter((e) => e.count >= 2 && e.count <= 500)
      .map((e) => ({ name: e.name, count: e.count, uuidValues: e.uuidValues, values: Array.from(e.distinct) }))
      .sort((a, b) => b.uuidValues - a.uuidValues || a.count - b.count)
      .slice(0, 50);

    const classMap = new Map();
    for (const el of all) {
      for (const c of (el.getAttribute('class') || '').split(/\s+/)) {
        if (c === '' || NOISE_CLASS.test(c)) continue;
        classMap.set(c, (classMap.get(c) || 0) + 1);
      }
    }
    const classes = Array.from(classMap.entries())
      .map(function (pair) { return { name: pair[0], count: pair[1] }; })
      .filter((e) => e.count >= 2 && e.count <= 150)
      .sort((a, b) => a.count - b.count)
      .slice(0, 70);

    return { elementCount: all.length, attributes: attributes, classes: classes };
  }

  // -------------------------------------------------------- network hook

  const origFetch = window.fetch;
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;
  const OrigEventSource = window.EventSource;

  function record(rec) {
    net.push(rec);
    if (net.length > 120) net.shift();
    return rec;
  }

  function interesting(url) {
    return /\/api\//.test(url) && !/\/rum\b|\/v2\/rum|datadog/.test(url);
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    let rec = null;

    if (interesting(url)) {
      rec = record({ via: 'fetch', method: method, path: safePath(url), at: Date.now() });
      collectUuids(url);
      const body = init && init.body;
      if (typeof body === 'string') {
        const parsed = parseMaybeJson(body);
        if (parsed !== null) { collectUuids(parsed); rec.requestShape = shape(parsed); }
        else rec.requestShape = 'non-json(' + body.length + ')';
      } else if (body) {
        rec.requestShape = 'body:' + Object.prototype.toString.call(body);
      }
    }

    const p = origFetch.apply(this, arguments);
    if (rec === null) return p;

    p.then(function (res) {
      rec.responseStatus = res.status;
      const ct = res.headers.get('content-type') || '';
      rec.responseContentType = ct;
      if (ct.indexOf('json') >= 0) {
        res.clone().json().then(function (j) {
          collectUuids(j);
          rec.responseShape = shape(j);
        }).catch(function () { rec.responseNote = 'the json body did not parse'; });
      } else if (ct.indexOf('event-stream') >= 0) {
        rec.responseNote = 'server sent events; the body is left alone so the stream survives';
      }
    }).catch(function () { rec.responseNote = 'the request failed'; });

    return p;
  };

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__probeMethod = String(method || '').toUpperCase();
    this.__probeUrl = String(url || '');
    return origXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__probeUrl || '';
    if (interesting(url)) {
      const rec = record({ via: 'xhr', method: this.__probeMethod, path: safePath(url), at: Date.now() });
      if (typeof body === 'string') {
        const parsed = parseMaybeJson(body);
        if (parsed !== null) { collectUuids(parsed); rec.requestShape = shape(parsed); }
        else rec.requestShape = 'non-json(' + body.length + ')';
      }
    }
    return origXhrSend.apply(this, arguments);
  };

  if (OrigEventSource !== undefined) {
    window.EventSource = function (url, cfg) {
      record({ via: 'eventsource', method: 'GET', path: safePath(url), at: Date.now() });
      collectUuids(String(url));
      return new OrigEventSource(url, cfg);
    };
    window.EventSource.prototype = OrigEventSource.prototype;
  }

  // A message may travel over a WebSocket instead of fetch. Hook that too.
  // A Proxy keeps the static members and the prototype chain intact.
  const OrigWebSocket = window.WebSocket;
  const socketStats = [];

  if (OrigWebSocket !== undefined) {
    window.WebSocket = new Proxy(OrigWebSocket, {
      construct(target, args) {
        const url = String(args[0]);
        const stat = {
          via: 'websocket',
          path: safePath(url),
          openedAt: Date.now(),
          framesOut: 0,
          framesIn: 0,
          outShapes: [],
          inShapes: [],
        };
        socketStats.push(stat);
        collectUuids(url);

        const ws = new target(...args);
        const origSend = ws.send.bind(ws);

        ws.send = function (data) {
          stat.framesOut++;
          if (typeof data === 'string') {
            const parsed = parseMaybeJson(data);
            if (parsed !== null) {
              collectUuids(parsed);
              if (stat.outShapes.length < 12) stat.outShapes.push(shape(parsed));
            } else if (stat.outShapes.length < 12) {
              stat.outShapes.push('non-json(' + data.length + ')');
            }
          } else if (stat.outShapes.length < 12) {
            stat.outShapes.push('binary:' + Object.prototype.toString.call(data));
          }
          return origSend(data);
        };

        ws.addEventListener('message', function (ev) {
          stat.framesIn++;
          if (typeof ev.data !== 'string') return;
          if (stat.framesIn <= 2000) {
            const parsed = parseMaybeJson(ev.data);
            if (parsed !== null) {
              collectUuids(parsed);
              if (stat.inShapes.length < 12) stat.inShapes.push(shape(parsed));
            } else if (stat.inShapes.length < 12) {
              stat.inShapes.push('non-json(' + ev.data.length + ')');
            }
          }
        });

        return ws;
      },
    });
  }

  // A beacon is another way to leave the page without fetch.
  const origBeacon = navigator.sendBeacon;
  if (typeof origBeacon === 'function') {
    navigator.sendBeacon = function (url, data) {
      if (interesting(String(url))) {
        const rec = record({ via: 'beacon', method: 'POST', path: safePath(String(url)), at: Date.now() });
        if (typeof data === 'string') {
          const parsed = parseMaybeJson(data);
          if (parsed !== null) { collectUuids(parsed); rec.requestShape = shape(parsed); }
        }
      }
      return origBeacon.apply(navigator, arguments);
    };
  }

  // ----------------------------------------------------- driver helpers

  /** The box you type a message into. */
  function composer() {
    const candidates = [
      'div[contenteditable="true"]',
      'textarea',
      '[role="textbox"]',
    ];
    for (const sel of candidates) {
      const list = document.querySelectorAll(sel);
      for (const el of list) {
        const r = el.getBoundingClientRect();
        if (r.width > 120 && r.height > 16) return el;
      }
    }
    return null;
  }

  /** Wait until the page text stops growing. This means the reply finished. */
  function waitSettled(quietMs, timeoutMs) {
    const quiet = quietMs || 1500;
    const limit = timeoutMs || 60000;
    return new Promise(function (resolve) {
      const started = Date.now();
      let lastLength = -1;
      let lastChange = Date.now();
      const timer = setInterval(function () {
        const length = (document.body.innerText || '').length;
        if (length !== lastLength) {
          lastLength = length;
          lastChange = Date.now();
        }
        const quietFor = Date.now() - lastChange;
        if (quietFor >= quiet) {
          clearInterval(timer);
          resolve({ settled: true, quietFor: quietFor, waitedMs: Date.now() - started });
        } else if (Date.now() - started > limit) {
          clearInterval(timer);
          resolve({ settled: false, quietFor: quietFor, waitedMs: Date.now() - started });
        }
      }, 250);
    });
  }

  let snapshotSet = null;

  function snapshot() {
    snapshotSet = new Set(document.querySelectorAll('*'));
    return snapshotSet.size;
  }

  function newElements() {
    if (snapshotSet === null) return [];
    const result = [];
    for (const el of document.querySelectorAll('*')) {
      if (!snapshotSet.has(el)) result.push(el);
    }
    return result;
  }

  /**
   * Describe one exchange.
   * `marker` is the text the driver typed. The driver knows it exactly,
   * so the probe can point at the real element with no guess and no click.
   */
  function analyzeTurn(marker, expectedUserMessages) {
    const fresh = newElements();
    const userHits = findByText(marker);
    // Document order, so the first hit is the question, not an echo in the reply.
    const userEl = userHits.length > 0 ? userHits[0] : null;

    // The reply is the biggest fresh text block that is not the user message.
    let replyEl = null;
    let bestLength = 0;
    for (const el of fresh) {
      if (userEl !== null && (el === userEl || el.contains(userEl) || userEl.contains(el))) continue;
      const len = (el.innerText || '').trim().length;
      if (len > bestLength && el.children.length <= 6) { bestLength = len; replyEl = el; }
    }

    const expected = expectedUserMessages || 0;
    const turnContainerGuesses = [];
    if (userEl !== null) {
      const chain = chainOf(userEl, 12);
      for (const level of chain) {
        for (const cand of level.selectorCandidates) {
          if (expected > 0 && (cand.matches === expected || cand.matches === expected * 2)) {
            turnContainerGuesses.push({
              level: level.level,
              selector: cand.selector,
              matches: cand.matches,
              meaning: cand.matches === expected ? 'one per user message' : 'one per message, both roles',
            });
          }
        }
      }
    }

    return {
      marker: 'redacted',
      freshElementCount: fresh.length,
      userMessage: userEl === null ? null : {
        matchCount: userHits.length,
        textLength: (userEl.textContent || '').length,
        chain: chainOf(userEl, 12),
      },
      assistantMessage: replyEl === null ? null : {
        textLength: bestLength,
        chain: chainOf(replyEl, 12),
      },
      turnContainerGuesses: turnContainerGuesses,
      scrollContainer: scrollContainerOf(userEl || replyEl || document.body),
    };
  }

  /** Which attribute or class tells a user message apart from a reply? */
  function roleDiscriminators(turn) {
    if (turn === null || turn.userMessage === null || turn.assistantMessage === null) return null;
    const take = function (chain) {
      const set = new Set();
      for (const level of chain) for (const c of level.selectorCandidates) set.add(c.selector);
      return set;
    };
    const u = take(turn.userMessage.chain);
    const a = take(turn.assistantMessage.chain);
    const withCount = function (s) { return { selector: s, matches: matchCount(s) }; };
    return {
      onlyOnUserMessage: Array.from(u).filter((x) => !a.has(x)).map(withCount).sort((p, q) => p.matches - q.matches),
      onlyOnAssistantMessage: Array.from(a).filter((x) => !u.has(x)).map(withCount).sort((p, q) => p.matches - q.matches),
      onBoth: Array.from(u).filter((x) => a.has(x)).map(withCount).sort((p, q) => p.matches - q.matches),
    };
  }

  // ------------------------------------------------------ transcript rows

  /** Hide a uuid inside an id, but keep the surrounding format readable. */
  function maskId(value) {
    if (typeof value !== 'string') return null;
    return value.replace(UUID_ANY, '<uuid>');
  }

  const ROW = '[data-testid="transcript-row"]';

  /**
   * Read the message list as the adapter will read it.
   * This is the structure the extension depends on, so report it exactly.
   */
  function transcript() {
    const rows = Array.prototype.slice.call(document.querySelectorAll(ROW));
    return rows.map(function (row, position) {
      let keyEl = row.hasAttribute('data-turn-key') ? row : row.querySelector('[data-turn-key]');
      if (keyEl === null) keyEl = row.closest('[data-turn-key]');
      const rawKey = keyEl === null ? null : keyEl.getAttribute('data-turn-key');

      let rowKeyEl = row.closest('[data-row-key]');
      if (rowKeyEl === null) rowKeyEl = row.querySelector('[data-row-key]');
      const rawRowKey = rowKeyEl === null ? null : rowKeyEl.getAttribute('data-row-key');

      return {
        position: position,
        role: row.getAttribute('data-perf-row'),
        index: row.getAttribute('data-index'),
        streaming: row.getAttribute('data-perf-row-streaming'),
        turnKeyFormat: maskId(rawKey),
        turnKeyLength: rawKey === null ? null : rawKey.length,
        turnKeyIsBareUuid: rawKey === null ? false : UUID.test(rawKey),
        turnKeyLevel: keyEl === null ? null : (keyEl === row ? 'row' : (row.contains(keyEl) ? 'inside' : 'ancestor')),
        rowKeyFormat: maskId(rawRowKey),
        hasUserScope: row.querySelector('[data-user-scope]') !== null,
        hasReplyScope: row.querySelector('[data-reply-scope]') !== null,
        hasMessageEdit: row.querySelector('[data-message-edit]') !== null,
        textLength: (row.innerText || '').trim().length,
      };
    });
  }

  /** Every uuid that the message list shows. We match these to the wire. */
  function turnKeyUuids() {
    const found = new Set();
    for (const el of document.querySelectorAll('[data-turn-key]')) {
      const v = el.getAttribute('data-turn-key') || '';
      const hits = v.match(UUID_ANY);
      if (hits !== null) for (const u of hits) found.add(u);
    }
    return Array.from(found);
  }

  /** How many of the list's uuids also travelled over the network? */
  function uuidOverlap() {
    const inDom = turnKeyUuids();
    let both = 0;
    for (const u of inDom) if (uuidsSeen.has(u)) both++;
    return { inDom: inDom.length, onWire: uuidsSeen.size, inBoth: both };
  }

  window.__probe = {
    __version: 3,
    net: net,
    uuidCount: function () { return uuidsSeen.size; },
    uuidList: function () { return Array.from(uuidsSeen); },
    census: census,
    transcript: transcript,
    turnKeyUuids: turnKeyUuids,
    uuidOverlap: uuidOverlap,
    socketStats: function () { return socketStats; },
    composer: composer,
    hasComposer: function () { return composer() !== null; },
    focusComposer: function () {
      const el = composer();
      if (el === null) return false;
      el.focus();
      if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        if (sel !== null) { sel.removeAllRanges(); sel.addRange(range); }
      }
      return document.activeElement === el || el.contains(document.activeElement);
    },
    snapshot: snapshot,
    waitSettled: waitSettled,
    analyzeTurn: analyzeTurn,
    roleDiscriminators: roleDiscriminators,
    findUuidInDom: findUuidInDom,
    findByTextCount: function (needle) { return findByText(needle).length; },
    conversationId: function () {
      const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
      return m === null ? null : m[1];
    },
    path: function () { return location.pathname.replace(UUID_ANY, '<uuid>'); },
    restore: function () {
      window.fetch = origFetch;
      XMLHttpRequest.prototype.open = origXhrOpen;
      XMLHttpRequest.prototype.send = origXhrSend;
      if (OrigEventSource !== undefined) window.EventSource = OrigEventSource;
      if (OrigWebSocket !== undefined) window.WebSocket = OrigWebSocket;
      if (typeof origBeacon === 'function') navigator.sendBeacon = origBeacon;
      return 'restored';
    },
  };
})();
