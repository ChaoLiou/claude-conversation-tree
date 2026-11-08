/**
 * Hold one tree per conversation.
 *
 * The extension stores the tree in the browser's own storage. A test stores
 * it in a map. Both satisfy `KeyValueArea`, so the store itself needs no
 * change between the two.
 */

import {
  createTree,
  deserialize,
  serialize,
  type RepairReport,
  type TreeState,
} from './tree.js';

/** The small part of a storage API that this project needs. */
export interface KeyValueArea {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
}

export const KEY_PREFIX = 'tree:v1:';

export function keyFor(conversationId: string): string {
  return KEY_PREFIX + conversationId;
}

export function conversationIdFromKey(key: string): string | null {
  return key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : null;
}

export interface LoadResult {
  readonly state: TreeState;
  /** True when storage held nothing, so this tree is new. */
  readonly fresh: boolean;
  /** What `repair` changed. It is empty in the normal case. */
  readonly fixes: readonly string[];
}

/** A store with a short delay on writes, so a stream does not hammer storage. */
export class TreeStore {
  readonly #area: KeyValueArea;
  readonly #debounceMs: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #queued: TreeState | null = null;

  constructor(area: KeyValueArea, options: { readonly debounceMs?: number } = {}) {
    this.#area = area;
    this.#debounceMs = options.debounceMs ?? 400;
  }

  async load(conversationId: string, now: number): Promise<LoadResult> {
    const raw = await this.#area.get(keyFor(conversationId));
    if (raw === null) {
      return { state: createTree(conversationId, now), fresh: true, fixes: [] };
    }
    const parsed = deserialize(raw, now);
    if (!parsed.ok) {
      // Unreadable storage must never block the panel. Start again, and say so.
      return {
        state: createTree(conversationId, now),
        fresh: true,
        fixes: [`the stored tree was dropped: ${parsed.error.code} ${parsed.error.message}`],
      };
    }
    const report: RepairReport = parsed.value;
    // A stored tree may name another conversation if a key was edited by hand.
    const state = report.state.conversationId === conversationId
      ? report.state
      : { ...report.state, conversationId };
    return { state, fresh: false, fixes: report.fixes };
  }

  /** Write now, and wait for the write. */
  async saveNow(state: TreeState): Promise<void> {
    this.#cancel();
    await this.#area.set(keyFor(state.conversationId), serialize(state));
  }

  /** Write after a short quiet moment. A later call replaces an earlier one. */
  saveSoon(state: TreeState): void {
    this.#queued = state;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      const queued = this.#queued;
      this.#timer = null;
      this.#queued = null;
      if (queued === null) return;
      void this.#area.set(keyFor(queued.conversationId), serialize(queued));
    }, this.#debounceMs);
  }

  /** Write anything still queued. Call it before the page goes away. */
  async flush(): Promise<void> {
    const queued = this.#queued;
    this.#cancel();
    if (queued !== null) {
      await this.#area.set(keyFor(queued.conversationId), serialize(queued));
    }
  }

  async remove(conversationId: string): Promise<void> {
    this.#cancel();
    await this.#area.remove(keyFor(conversationId));
  }

  async listConversations(): Promise<string[]> {
    const keys = await this.#area.keys();
    const result: string[] = [];
    for (const key of keys) {
      const id = conversationIdFromKey(key);
      if (id !== null) result.push(id);
    }
    return result;
  }

  #cancel(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#queued = null;
  }
}

/** A store for a test, or for the mock page. */
export function memoryArea(initial: Readonly<Record<string, string>> = {}): KeyValueArea {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    async get(key) { return map.get(key) ?? null; },
    async set(key, value) { map.set(key, value); },
    async remove(key) { map.delete(key); },
    async keys() { return Array.from(map.keys()); },
  };
}

/** The shape of the browser extension storage area that this wraps. */
export interface ExtensionStorageArea {
  get(keys: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** A store backed by `browser.storage.local`, which Chrome also provides. */
export function extensionArea(area: ExtensionStorageArea): KeyValueArea {
  return {
    async get(key) {
      const bag = await area.get(key);
      const value = bag[key];
      return typeof value === 'string' ? value : null;
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
    async remove(key) {
      await area.remove(key);
    },
    async keys() {
      const bag = await area.get(null);
      return Object.keys(bag);
    },
  };
}

/** A store backed by the page's own `localStorage`. The mock page uses it. */
export function localStorageArea(prefix = ''): KeyValueArea {
  return {
    async get(key) {
      return localStorage.getItem(prefix + key);
    },
    async set(key, value) {
      localStorage.setItem(prefix + key, value);
    },
    async remove(key) {
      localStorage.removeItem(prefix + key);
    },
    async keys() {
      const result: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key === null) continue;
        if (prefix !== '' && !key.startsWith(prefix)) continue;
        result.push(prefix === '' ? key : key.slice(prefix.length));
      }
      return result;
    },
  };
}
