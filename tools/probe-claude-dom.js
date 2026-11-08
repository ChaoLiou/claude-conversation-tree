/**
 * Phase 0 probe v2 for the claude.ai conversation tree extension.
 *
 * WHAT IT DOES
 *   It reads the page structure and the shape of the site's own API calls.
 *   It only reads. It sends nothing anywhere. It changes no conversation.
 *
 * WHY v2
 *   v1 guessed the CSS selectors for a message. Every guess missed.
 *   v2 does not guess. You click a message, and the probe reports what
 *   that element really is.
 *
 * PRIVACY
 *   It never records message text, titles, or any long string value.
 *   For every string it records only a type: "uuid" or "string(<length>)".
 *   A short safe string keeps its value, so that role names stay readable.
 *   Field NAMES are kept, because the adapter needs them.
 *   Read the JSON before you paste it back. You will see no prose in it.
 *
 * HOW TO USE  (follow every step, in order)
 *   1. Paste this whole file into the Console. Press Enter.
 *   2. Open a conversation that ALREADY HAS several questions and answers.
 *      A new empty chat gives nothing. The probe survives the navigation.
 *   3. Run:  __probe.rescan()
 *   4. Run:  __probe.pickUser()      then click one of YOUR messages.
 *   5. Run:  __probe.pickAssistant() then click one of CLAUDE's replies.
 *   6. Send one short message in the chat, for example "hi". Wait for the reply.
 *   7. Run:  __probe.report()        The JSON lands on your clipboard.
 *   8. Run:  __probe.restore()       Or just reload the page.
 *
 *   A click in step 4 or 5 does not reach the page. Nothing opens or changes.
 */
(() => {
  'use strict';

  if (window.__probe && typeof window.__probe.restore === 'function') {
    window.__probe.restore();
    console.log('%cearlier probe removed', 'color:#a60');
  }

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  // Tailwind-style layout classes carry no meaning for us. Drop them.
  const NOISE_CLASS = /^(-?(flex|grid|block|inline|contents|hidden|table|relative|absolute|fixed|sticky|static|isolate|overflow|truncate|whitespace|break|select|cursor|pointer|transition|duration|ease|delay|animate|transform|translate|scale|rotate|opacity|shadow|ring|outline|rounded|border|divide|bg|text|font|leading|tracking|antialiased|list|align|place|items|justify|self|content|order|col|row|gap|space|w|h|min|max|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|top|right|bottom|left|inset|z|basis|grow|shrink|flex-|sm:|md:|lg:|xl:|2xl:|hover:|focus:|active:|group-hover:|dark:)([-:]|$))/;

  const out = {
    probeVersion: 2,
    probedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    static: null,
    picks: {},
    pickDiff: null,
    net: [],
    notes: [],
  };

  // ---------------------------------------------------------------- helpers

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
      if (UUID.test(v)) return 'uuid';
      if (v.length <= 24 && /^[\w .:+/@-]*$/.test(v)) return 'short:' + v;
      return 'string(' + v.length + ')';
    }
    return typeof v;
  }

  function safePath(url) {
    try {
      const u = new URL(url, location.origin);
      const keys = [...u.searchParams.keys()];
      return u.pathname.replace(UUID_ANY, '<uuid>') + (keys.length ? '?' + keys.join('&') : '');
    } catch (e) {
      return String(url).slice(0, 90).replace(UUID_ANY, '<uuid>');
    }
  }

  function parseMaybeJson(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function attrsOf(el) {
    const o = {};
    for (const a of el.attributes) {
      if (a.name === 'class' || a.name === 'style') continue;
      o[a.name] = shape(a.value);
    }
    return o;
  }

  function meaningfulClasses(el) {
    return (el.getAttribute('class') || '')
      .split(/\s+/)
      .filter((c) => c && !NOISE_CLASS.test(c))
      .slice(0, 12);
  }

  function count(sel) {
    try { return document.querySelectorAll(sel).length; } catch (e) { return -1; }
  }

  // Build selectors that could identify this element, and count their matches.
  function selectorCandidates(el) {
    const list = [];
    for (const a of el.attributes) {
      if (a.name === 'class' || a.name === 'style') continue;
      if (!/^(data-|aria-)/.test(a.name) && a.name !== 'role') continue;
      const useValue = a.value !== '' && a.value.length <= 30 && !UUID.test(a.value);
      list.push(useValue ? '[' + a.name + '="' + a.value.replace(/"/g, '\\"') + '"]' : '[' + a.name + ']');
    }
    for (const c of meaningfulClasses(el)) {
      try { list.push('.' + CSS.escape(c)); } catch (e) { /* skip */ }
    }
    const seen = new Set();
    const result = [];
    for (const s of list) {
      if (seen.has(s)) continue;
      seen.add(s);
      const n = count(s);
      if (n > 0 && n <= 400) result.push({ selector: s, matches: n });
    }
    return result.sort((a, b) => a.matches - b.matches);
  }

  function chainOf(startEl, levels) {
    const chain = [];
    let el = startEl;
    for (let i = 0; i < levels && el && el !== document.documentElement; i++) {
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

  // --------------------------------------------------------- static scan

  function scan() {
    const s = {
      path: location.pathname.replace(UUID_ANY, '<uuid>'),
      conversationUuidFound: /\/chat\/[0-9a-f-]{36}/i.test(location.pathname),
      elementCount: document.querySelectorAll('*').length,
      attributeCensus: [],
      classCensus: [],
      classPrefixes: [],
      ariaRoles: [],
      notes: [],
    };

    const all = document.querySelectorAll('*');

    // data-* attributes. A per-message one repeats a few times, not once.
    const attrMap = new Map();
    for (const el of all) {
      for (const a of el.attributes) {
        if (a.name.indexOf('data-') !== 0) continue;
        let e = attrMap.get(a.name);
        if (!e) attrMap.set(a.name, (e = { name: a.name, count: 0, uuidValues: 0, distinct: new Set() }));
        e.count++;
        if (UUID.test(a.value)) e.uuidValues++;
        if (e.distinct.size < 6) e.distinct.add(a.value.length > 30 ? '<long:' + a.value.length + '>' : a.value);
      }
    }
    s.attributeCensus = [...attrMap.values()]
      .filter((e) => e.count >= 2 && e.count <= 400)
      .map((e) => ({ name: e.name, count: e.count, uuidValues: e.uuidValues, values: [...e.distinct] }))
      .sort((a, b) => b.uuidValues - a.uuidValues || a.count - b.count)
      .slice(0, 50);
    s.notes.push('data-* attributes that appear exactly once are omitted; they are page-level boot flags');

    // class names, noise removed
    const classMap = new Map();
    for (const el of all) {
      for (const c of (el.getAttribute('class') || '').split(/\s+/)) {
        if (!c || NOISE_CLASS.test(c)) continue;
        classMap.set(c, (classMap.get(c) || 0) + 1);
      }
    }
    const classArr = [...classMap.entries()].map(([name, n]) => ({ name: name, count: n }));
    s.classCensus = classArr
      .filter((e) => e.count >= 2 && e.count <= 120)
      .sort((a, b) => a.count - b.count)
      .slice(0, 70);

    const prefMap = new Map();
    for (const e of classArr) {
      const p = e.name.split(/[-_/:]/)[0];
      prefMap.set(p, (prefMap.get(p) || 0) + e.count);
    }
    s.classPrefixes = [...prefMap.entries()]
      .map(([name, n]) => ({ prefix: name, totalUses: n }))
      .sort((a, b) => b.totalUses - a.totalUses)
      .slice(0, 25);

    const roleMap = new Map();
    for (const el of all) {
      const r = el.getAttribute('role');
      if (r) roleMap.set(r, (roleMap.get(r) || 0) + 1);
    }
    s.ariaRoles = [...roleMap.entries()].map(([name, n]) => ({ role: name, count: n })).sort((a, b) => a.count - b.count);

    if (!s.conversationUuidFound) {
      s.notes.push('WARNING: this is not a conversation page. Open an existing conversation, then run __probe.rescan()');
    }
    if (s.elementCount < 1500) {
      s.notes.push('WARNING: only ' + s.elementCount + ' elements. The conversation may not be loaded yet.');
    }

    out.static = s;
    return s;
  }

  // --------------------------------------------------------- click picking

  let activePick = null;

  function installPick(label, hint) {
    if (activePick) {
      document.removeEventListener('click', activePick, true);
      activePick = null;
    }
    const handler = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      document.removeEventListener('click', handler, true);
      activePick = null;
      const chain = chainOf(ev.target, 12);
      out.picks[label] = chain;
      console.log('%ccaptured "' + label + '" (' + chain.length + ' levels up)', 'color:#0a0');
      console.table(chain.map((c) => ({
        level: c.level, tag: c.tag, textLength: c.textLength, childCount: c.childCount,
        classes: c.classes.join(' '),
        bestSelector: c.selectorCandidates.length ? c.selectorCandidates[0].selector + ' x' + c.selectorCandidates[0].matches : '-',
      })));
      diffPicks();
    };
    activePick = handler;
    document.addEventListener('click', handler, true);
    console.log('%c' + hint, 'color:#06c;font-weight:bold');
  }

  // Which attribute or class separates a user message from a reply?
  function diffPicks() {
    const u = out.picks.userMessage;
    const a = out.picks.assistantMessage;
    if (!u || !a) return;
    const sel = (chain) => {
      const set = new Set();
      for (const lv of chain) for (const c of lv.selectorCandidates) set.add(c.selector);
      return set;
    };
    const su = sel(u);
    const sa = sel(a);
    out.pickDiff = {
      onlyOnUserMessage: [...su].filter((x) => !sa.has(x)).map((x) => ({ selector: x, matches: count(x) })),
      onlyOnAssistantMessage: [...sa].filter((x) => !su.has(x)).map((x) => ({ selector: x, matches: count(x) })),
      onBoth: [...su].filter((x) => sa.has(x)).map((x) => ({ selector: x, matches: count(x) })).sort((p, q) => p.matches - q.matches),
    };
    console.log('%crole discriminators found', 'color:#0a0', out.pickDiff);
  }

  // --------------------------------------------------------- scroll target

  function findScrollContainer(el) {
    let s = el && el.parentElement;
    for (let i = 0; i < 25 && s; i++) {
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

  // ------------------------------------------------- network call shapes

  const origFetch = window.fetch;
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;
  const OrigEventSource = window.EventSource;

  function record(rec) {
    out.net.push(rec);
    if (out.net.length > 80) out.net.shift();
    return rec;
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    let rec = null;

    if (/\/api\//.test(url) && !/\/rum\b/.test(url)) {
      rec = record({ via: 'fetch', method: method, path: safePath(url) });
      const body = init && init.body;
      if (typeof body === 'string') {
        const j = parseMaybeJson(body);
        rec.requestShape = j ? shape(j) : 'non-json(' + body.length + ')';
      } else if (body) {
        rec.requestShape = 'body:' + Object.prototype.toString.call(body);
      }
    }

    const p = origFetch.apply(this, arguments);
    if (!rec) return p;

    p.then((res) => {
      rec.responseStatus = res.status;
      rec.responseContentType = res.headers.get('content-type');
      const ct = rec.responseContentType || '';
      if (ct.indexOf('json') >= 0) {
        res.clone().json()
          .then((j) => { rec.responseShape = shape(j); })
          .catch((e) => { rec.responseNote = 'json parse failed'; });
      } else if (ct.indexOf('event-stream') >= 0) {
        rec.responseNote = 'server sent events; body not read, to keep the stream intact';
      }
    }).catch(() => {});

    return p;
  };

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__probeMethod = String(method || '').toUpperCase();
    this.__probeUrl = String(url || '');
    return origXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__probeUrl || '';
    if (/\/api\//.test(url) && !/\/rum\b/.test(url)) {
      const rec = record({ via: 'xhr', method: this.__probeMethod, path: safePath(url) });
      if (typeof body === 'string') {
        const j = parseMaybeJson(body);
        rec.requestShape = j ? shape(j) : 'non-json(' + body.length + ')';
      }
    }
    return origXhrSend.apply(this, arguments);
  };

  if (OrigEventSource) {
    window.EventSource = function (url, cfg) {
      record({ via: 'eventsource', method: 'GET', path: safePath(url) });
      return new OrigEventSource(url, cfg);
    };
    window.EventSource.prototype = OrigEventSource.prototype;
  }

  // ------------------------------------------------------------- report

  function checklist() {
    const s = out.static;
    const items = [
      { ok: Boolean(s), label: 'static scan done (run __probe.rescan())' },
      { ok: Boolean(s && s.conversationUuidFound), label: 'on a real conversation page' },
      { ok: Boolean(s && s.elementCount >= 1500), label: 'conversation looks loaded' },
      { ok: Boolean(out.picks.userMessage), label: 'your own message picked (__probe.pickUser())' },
      { ok: Boolean(out.picks.assistantMessage), label: 'a Claude reply picked (__probe.pickAssistant())' },
      { ok: out.net.some((r) => r.method === 'POST'), label: 'one message sent while the probe ran' },
      { ok: out.net.some((r) => /chat_conversations/.test(r.path) && r.method === 'GET'), label: 'conversation fetched while the probe ran' },
    ];
    return items;
  }

  window.__probe = {
    data: out,
    rescan: function () {
      const s = scan();
      if (out.picks.userMessage) {
        out.scrollContainerFromPick = findScrollContainer(document.body);
      }
      console.log('%cscan done', 'color:#0a0', {
        path: s.path, elementCount: s.elementCount,
        topAttributes: s.attributeCensus.slice(0, 10),
        classPrefixes: s.classPrefixes.slice(0, 10),
        rarestClasses: s.classCensus.slice(0, 15),
      });
      for (const n of s.notes) if (n.indexOf('WARNING') === 0) console.warn(n);
      return s;
    },
    pickUser: function () { installPick('userMessage', 'Now click the text of ONE of your own messages.'); },
    pickAssistant: function () { installPick('assistantMessage', 'Now click the text of ONE of Claude\'s replies.'); },
    pickOther: function (name) { installPick(name || 'other', 'Now click the element you want described.'); },
    report: function () {
      const items = checklist();
      const missing = items.filter((i) => !i.ok);
      out.checklist = items.map((i) => (i.ok ? 'OK   ' : 'MISS ') + i.label);
      const json = JSON.stringify(out, null, 2);
      if (missing.length) {
        console.warn('%c' + missing.length + ' step(s) incomplete. The report will be thin:', 'color:#c00;font-weight:bold');
        for (const m of missing) console.warn('  MISSING: ' + m.label);
      }
      try { copy(json); console.log('%cJSON copied to the clipboard. Length ' + json.length, 'color:#0a0;font-weight:bold'); }
      catch (e) { console.log('copy() not available; select the output below'); }
      console.log(json);
      return out;
    },
    restore: function () {
      window.fetch = origFetch;
      XMLHttpRequest.prototype.open = origXhrOpen;
      XMLHttpRequest.prototype.send = origXhrSend;
      if (OrigEventSource) window.EventSource = OrigEventSource;
      if (activePick) { document.removeEventListener('click', activePick, true); activePick = null; }
      console.log('originals restored');
    },
  };

  console.log('%cProbe v2 installed. It survives page navigation inside the app.', 'color:#0a0;font-weight:bold');
  console.log('Next: open a conversation that already has several questions and answers.');
  console.log('Then run, in order:');
  console.log('  __probe.rescan()');
  console.log('  __probe.pickUser()        then click one of YOUR messages');
  console.log('  __probe.pickAssistant()   then click one of CLAUDE\'s replies');
  console.log('  ... send one short message in the chat, wait for the reply ...');
  console.log('  __probe.report()');
})();
