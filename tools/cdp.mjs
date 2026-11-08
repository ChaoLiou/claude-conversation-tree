/**
 * A minimal Chrome DevTools Protocol client.
 *
 * It has no dependencies. Node 24 holds a global `WebSocket`, so this file
 * needs nothing from npm. It covers only what the dev loop needs: find a
 * tab, run code in it, type into it, and take a picture of it.
 */

export const DEFAULT_PORT = 9222;

/** Read one of Chrome's plain HTTP debug endpoints. */
export async function cdpHttp(path, port = DEFAULT_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!res.ok) throw new Error(`CDP ${path} answered ${res.status}`);
  return res.json();
}

export function cdpVersion(port = DEFAULT_PORT) {
  return cdpHttp('/json/version', port);
}

export function cdpTargets(port = DEFAULT_PORT) {
  return cdpHttp('/json/list', port);
}

/** Wait until the debug port answers. It throws after the timeout. */
export async function waitForCdp(port = DEFAULT_PORT, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'none';
  while (Date.now() < deadline) {
    try {
      return await cdpVersion(port);
    } catch (e) {
      lastError = String(e.message || e);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error(`the debug port ${port} never answered. Last error: ${lastError}`);
}

/**
 * Find one page target whose url matches `pattern`.
 * `pattern` is a string to search for, or a regular expression.
 */
export async function findPage(pattern, port = DEFAULT_PORT) {
  const targets = await cdpTargets(port);
  const test = pattern instanceof RegExp
    ? (url) => pattern.test(url)
    : (url) => url.includes(pattern);
  return targets.find((t) => t.type === 'page' && test(t.url)) ?? null;
}

/** Open a new tab and return its target. */
export async function openPage(url, port = DEFAULT_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!res.ok) throw new Error(`could not open a tab: ${res.status}`);
  return res.json();
}

export class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #handlers = new Map();
  #closed = false;

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => this.#onMessage(ev));
    ws.addEventListener('close', () => {
      this.#closed = true;
      for (const [, p] of this.#pending) p.reject(new Error('the CDP socket closed'));
      this.#pending.clear();
    });
  }

  /** Attach to a target by its `webSocketDebuggerUrl`. */
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`could not open ${wsUrl}`)), { once: true });
    });
    return new Cdp(ws);
  }

  #onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method} failed: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    const list = this.#handlers.get(msg.method);
    if (list) for (const fn of list) fn(msg.params, msg.sessionId);
  }

  /**
   * Send one command. It resolves with the result.
   * Pass `sessionId` to speak to an attached child target, such as a worker.
   */
  send(method, params = {}, sessionId = undefined) {
    if (this.#closed) return Promise.reject(new Error('the CDP socket is closed'));
    const id = this.#nextId++;
    const message = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
    const payload = JSON.stringify(message);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(payload);
    });
  }

  /** Listen for a protocol event, for example `Runtime.consoleAPICalled`. */
  on(event, fn) {
    const list = this.#handlers.get(event) ?? [];
    list.push(fn);
    this.#handlers.set(event, list);
    return () => {
      const current = this.#handlers.get(event) ?? [];
      this.#handlers.set(event, current.filter((f) => f !== fn));
    };
  }

  /**
   * Run an expression in the page and return its value.
   * It throws when the page throws, and it reports the page's message.
   */
  async evaluate(expression, { awaitPromise = true, returnByValue = true, sessionId = undefined } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      allowUnsafeEvalBlockedByCSP: true,
      userGesture: true,
    }, sessionId);
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const text = d.exception?.description ?? d.text ?? 'unknown page error';
      throw new Error(`the page threw: ${text}`);
    }
    return res.result?.value;
  }

  /** Forward the page's console lines to this process. */
  async pipeConsole(prefix = 'page') {
    await this.send('Runtime.enable');
    this.on('Runtime.consoleAPICalled', (p) => {
      const parts = (p.args ?? []).map((a) => {
        if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
        return a.description ?? a.type;
      });
      console.log(`[${prefix}:${p.type}] ${parts.join(' ')}`);
    });
    this.on('Runtime.exceptionThrown', (p) => {
      console.log(`[${prefix}:error] ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
    });
  }

  /** Type text into whatever holds the focus. */
  async typeText(text) {
    await this.send('Input.insertText', { text });
  }

  async pressKey(key) {
    const map = {
      Enter: { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' },
      Escape: { windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' },
      Tab: { windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', text: '\t' },
    };
    const spec = map[key];
    if (!spec) throw new Error(`key ${key} is not in the map`);
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec });
  }

  /** Save a screenshot. It returns the raw bytes. */
  async screenshot() {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(res.data, 'base64');
  }

  async navigate(url) {
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
  }

  close() {
    this.#closed = true;
    try { this.#ws.close(); } catch { /* already gone */ }
  }
}

/** Wait until `expression` returns a true value in the page. */
export async function waitFor(cdp, expression, { timeoutMs = 30000, everyMs = 300, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await cdp.evaluate(`(() => { try { return (${expression}); } catch (e) { return false; } })()`);
    if (value) return value;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms while waiting for: ${label}`);
}
