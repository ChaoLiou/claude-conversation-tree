import { describe, expect, it } from 'vitest';
import {
  TreeStore,
  conversationIdFromKey,
  extensionArea,
  keyFor,
  memoryArea,
  type ExtensionStorageArea,
} from '../src/core/store.js';
import { addNode, createTree, nodeCount, serialize, type Result } from '../src/core/tree.js';

function must<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function tick(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('keys', () => {
  it('round trips a conversation id', () => {
    const id = 'abc-123';
    expect(conversationIdFromKey(keyFor(id))).toBe(id);
  });

  it('ignores a key that belongs to something else', () => {
    expect(conversationIdFromKey('other:thing')).toBeNull();
  });
});

describe('TreeStore.load', () => {
  it('gives a fresh tree when storage is empty', async () => {
    const store = new TreeStore(memoryArea());
    const result = await store.load('c1', 1000);
    expect(result.fresh).toBe(true);
    expect(result.fixes).toEqual([]);
    expect(nodeCount(result.state)).toBe(0);
    expect(result.state.conversationId).toBe('c1');
  });

  it('reads a tree it wrote', async () => {
    const store = new TreeStore(memoryArea());
    const state = must(addNode(createTree('c1', 1), { id: 'q1', label: 'Q1' }, null, 1));
    await store.saveNow(state);

    const loaded = await store.load('c1', 2000);
    expect(loaded.fresh).toBe(false);
    expect(nodeCount(loaded.state)).toBe(1);
    expect(loaded.state.nodes['q1']?.label).toBe('Q1');
  });

  it('starts again, and reports why, when storage holds rubbish', async () => {
    const area = memoryArea({ [keyFor('c1')]: 'not json at all' });
    const store = new TreeStore(area);
    const loaded = await store.load('c1', 2000);
    expect(loaded.fresh).toBe(true);
    expect(nodeCount(loaded.state)).toBe(0);
    expect(loaded.fixes.join(' ')).toContain('dropped');
  });

  it('repairs a stored tree that holds an orphan', async () => {
    const sound = must(addNode(createTree('c1', 1), { id: 'q1', label: 'Q1' }, null, 1));
    const broken = {
      ...sound,
      nodes: {
        ...sound.nodes,
        q2: {
          id: 'q2', parentId: 'gone', position: null,
          label: 'Q2', createdAt: 2, order: 0,
        },
      },
    };
    const area = memoryArea({ [keyFor('c1')]: serialize(broken) });
    const loaded = await new TreeStore(area).load('c1', 2000);
    expect(loaded.state.nodes['q2']?.parentId).toBeNull();
    expect(loaded.fixes.length).toBeGreaterThan(0);
  });

  it('corrects a tree stored under the wrong conversation', async () => {
    const other = must(addNode(createTree('other', 1), { id: 'q1', label: 'Q1' }, null, 1));
    const area = memoryArea({ [keyFor('c1')]: serialize(other) });
    const loaded = await new TreeStore(area).load('c1', 2000);
    expect(loaded.state.conversationId).toBe('c1');
  });
});

describe('TreeStore writes', () => {
  it('delays a write, then performs it', async () => {
    const area = memoryArea();
    const store = new TreeStore(area, { debounceMs: 30 });
    const state = must(addNode(createTree('c1', 1), { id: 'q1', label: 'Q1' }, null, 1));

    store.saveSoon(state);
    expect(await area.get(keyFor('c1'))).toBeNull();

    await tick(70);
    expect(await area.get(keyFor('c1'))).not.toBeNull();
  });

  it('keeps only the last of several delayed writes', async () => {
    const area = memoryArea();
    const store = new TreeStore(area, { debounceMs: 30 });
    const one = must(addNode(createTree('c1', 1), { id: 'q1', label: 'first' }, null, 1));
    const two = must(addNode(one, { id: 'q2', label: 'second' }, 'q1', 2));

    store.saveSoon(one);
    store.saveSoon(two);
    await tick(70);

    const loaded = await store.load('c1', 3);
    expect(nodeCount(loaded.state)).toBe(2);
  });

  it('writes a queued tree when you flush it', async () => {
    const area = memoryArea();
    const store = new TreeStore(area, { debounceMs: 5000 });
    const state = must(addNode(createTree('c1', 1), { id: 'q1', label: 'Q1' }, null, 1));
    store.saveSoon(state);
    await store.flush();
    expect(await area.get(keyFor('c1'))).not.toBeNull();
  });

  it('drops a queued write when you save at once', async () => {
    const area = memoryArea();
    const store = new TreeStore(area, { debounceMs: 20 });
    const one = must(addNode(createTree('c1', 1), { id: 'q1', label: 'first' }, null, 1));
    store.saveSoon(one);
    await store.saveNow(createTree('c1', 2));
    await tick(50);
    const loaded = await store.load('c1', 3);
    expect(nodeCount(loaded.state)).toBe(0);
  });
});

describe('TreeStore.listConversations', () => {
  it('reports only its own keys', async () => {
    const area = memoryArea({
      [keyFor('c1')]: serialize(createTree('c1', 1)),
      [keyFor('c2')]: serialize(createTree('c2', 1)),
      'someone-else': 'value',
    });
    const list = await new TreeStore(area).listConversations();
    expect(list.sort()).toEqual(['c1', 'c2']);
  });
});

describe('extensionArea', () => {
  it('speaks to a browser storage area', async () => {
    const bag: Record<string, unknown> = {};
    const fake: ExtensionStorageArea = {
      async get(keys) {
        if (keys === null) return { ...bag };
        return keys in bag ? { [keys]: bag[keys] } : {};
      },
      async set(items) { Object.assign(bag, items); },
      async remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete bag[k];
      },
    };

    const area = extensionArea(fake);
    expect(await area.get('missing')).toBeNull();
    await area.set('a', 'one');
    expect(await area.get('a')).toBe('one');
    expect(await area.keys()).toEqual(['a']);
    await area.remove('a');
    expect(await area.get('a')).toBeNull();
  });

  it('treats a value that is not a string as absent', async () => {
    const fake: ExtensionStorageArea = {
      async get() { return { a: 42 }; },
      async set() { /* not used */ },
      async remove() { /* not used */ },
    };
    expect(await extensionArea(fake).get('a')).toBeNull();
  });
});
