import { describe, expect, it } from 'vitest';
import {
  addNode,
  createTree,
  deriveLabel,
  deserialize,
  getChildren,
  getRoots,
  isDescendantOf,
  isLinked,
  isEmpty,
  linearize,
  nodeCount,
  pathToRoot,
  removeNode,
  repair,
  serialize,
  setLabel,
  setParent,
  setPosition,
  subtreeIds,
  type Result,
  type TreeState,
} from '../src/core/tree.js';

/** Unwrap a successful result, or fail the test with the error code. */
function must<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function errorOf<T>(result: Result<T>): string {
  if (result.ok) throw new Error('expected an error, got ok');
  return result.error.code;
}

/** A clock that moves one millisecond per call, so creation order is stable. */
function clock(start = 1000): () => number {
  let t = start;
  return () => ++t;
}

/** Build a tree from a list of [id, parentId] pairs. */
function build(pairs: ReadonlyArray<readonly [string, string | null]>): TreeState {
  const now = clock();
  let state = createTree('conv-1', now());
  for (const [id, parentId] of pairs) {
    state = must(addNode(state, { id, label: id.toUpperCase() }, parentId, now()));
  }
  return state;
}

describe('deriveLabel', () => {
  it('collapses every run of whitespace', () => {
    expect(deriveLabel('how  do\n\tI   do this')).toBe('how do I do this');
  });

  it('truncates a long message and marks the cut', () => {
    const label = deriveLabel('x'.repeat(100), 10);
    expect(label).toHaveLength(10);
    expect(label.endsWith('…')).toBe(true);
  });

  it('reports an empty message', () => {
    expect(deriveLabel('   \n  ')).toBe('(empty)');
  });

  it('leaves a short message alone', () => {
    expect(deriveLabel('short')).toBe('short');
  });
});

describe('an empty tree', () => {
  it('has no nodes and no roots', () => {
    const state = createTree('conv-1', 1);
    expect(isEmpty(state)).toBe(true);
    expect(nodeCount(state)).toBe(0);
    expect(getRoots(state)).toEqual([]);
    expect(linearize(state)).toEqual([]);
  });
});

describe('a new exchange', () => {
  it('stands on its own, because only the user makes a link', () => {
    const now = clock();
    let state = createTree('conv-1', now());
    // There is no default parent and no pending choice. An exchange that
    // arrives is a tree of one node until the user says otherwise.
    for (const id of ['q1', 'q2', 'q3']) {
      state = must(addNode(state, { id, label: id }, null, now()));
    }
    expect(getRoots(state).map((n) => n.id)).toEqual(['q1', 'q2', 'q3']);
    expect(pathToRoot(state, 'q3').map((n) => n.id)).toEqual(['q3']);
  });
});

describe('the branching case this extension exists for', () => {
  it('attaches three follow-up questions to the same first answer', () => {
    const now = clock();
    let state = createTree('conv-1', now());

    // The first exchange.
    state = must(addNode(state, { id: 'q1', label: 'the first question' }, null, now()));

    // Three follow-ups. Each one arrives on its own, and then the user
    // puts it under q1. Each one depends on q1, not on the one before it.
    for (const id of ['q2', 'q3', 'q4']) {
      state = must(addNode(state, { id, label: id }, null, now()));
      state = must(setParent(state, id, 'q1', now()));
    }

    expect(getRoots(state).map((n) => n.id)).toEqual(['q1']);
    expect(getChildren(state, 'q1').map((n) => n.id)).toEqual(['q2', 'q3', 'q4']);

    // q3 must not sit under q2.
    expect(getChildren(state, 'q2')).toEqual([]);
    expect(pathToRoot(state, 'q3').map((n) => n.id)).toEqual(['q1', 'q3']);
    expect(isDescendantOf(state, 'q3', 'q2')).toBe(false);
    expect(isDescendantOf(state, 'q3', 'q1')).toBe(true);
  });

});

describe('addNode guards', () => {
  it('rejects the same id twice', () => {
    const state = build([['q1', null]]);
    expect(errorOf(addNode(state, { id: 'q1', label: 'again' }, null, 2))).toBe('DUPLICATE_NODE');
  });

  it('rejects a parent that is not in the tree', () => {
    const state = build([['q1', null]]);
    expect(errorOf(addNode(state, { id: 'q2', label: 'Q2' }, 'ghost', 2))).toBe('PARENT_NOT_FOUND');
  });

  it('rejects a node that names itself as the parent', () => {
    const state = build([['q1', null]]);
    expect(errorOf(addNode(state, { id: 'q2', label: 'Q2' }, 'q2', 2))).toBe('SELF_PARENT');
  });

  it('rejects an empty id', () => {
    const state = build([['q1', null]]);
    expect(errorOf(addNode(state, { id: '', label: 'x' }, null, 2))).toBe('BAD_PAYLOAD');
  });

  it('does not change the state it was given', () => {
    const state = build([['q1', null]]);
    const before = serialize(state);
    must(addNode(state, { id: 'q2', label: 'Q2' }, 'q1', 99));
    expect(serialize(state)).toBe(before);
  });
});

describe('setParent', () => {
  it('moves a node and its whole subtree', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q2'],
      ['q4', 'q1'],
    ]);
    const moved = must(setParent(state, 'q2', 'q4', 99));
    expect(pathToRoot(moved, 'q3').map((n) => n.id)).toEqual(['q1', 'q4', 'q2', 'q3']);
  });

  it('refuses to put a node under its own descendant', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q2'],
    ]);
    expect(errorOf(setParent(state, 'q1', 'q3', 99))).toBe('WOULD_CREATE_CYCLE');
  });

  it('refuses to make a node its own parent', () => {
    const state = build([['q1', null]]);
    expect(errorOf(setParent(state, 'q1', 'q1', 99))).toBe('SELF_PARENT');
  });

  it('promotes a node to a root', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
    ]);
    const moved = must(setParent(state, 'q2', null, 99));
    expect(getRoots(moved).map((n) => n.id)).toEqual(['q1', 'q2']);
  });

  it('returns the same state when the parent does not change', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
    ]);
    expect(must(setParent(state, 'q2', 'q1', 99))).toBe(state);
  });
});

describe('removeNode', () => {
  it('lifts the children to the grandparent by default', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q2'],
      ['q4', 'q2'],
    ]);
    const after = must(removeNode(state, 'q2', { cascade: false }, 99));
    expect(nodeCount(after)).toBe(3);
    expect(getChildren(after, 'q1').map((n) => n.id).sort()).toEqual(['q3', 'q4']);
  });

  it('removes the whole subtree when asked', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q2'],
      ['q4', 'q1'],
    ]);
    const after = must(removeNode(state, 'q2', { cascade: true }, 99));
    expect(Object.keys(after.nodes).sort()).toEqual(['q1', 'q4']);
  });

  it('rejects an unknown node', () => {
    const state = build([['q1', null]]);
    expect(errorOf(removeNode(state, 'ghost', { cascade: false }, 99))).toBe('NODE_NOT_FOUND');
  });
});

describe('linearize', () => {
  it('walks depth first and reports how many parents each row has', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q2'],
      ['q4', 'q1'],
      ['q5', null],
    ]);
    const rows = linearize(state);
    expect(rows.map((r) => r.node.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1, 0]);
  });

  it('reports the child count and the last sibling', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q1'],
    ]);
    const rows = linearize(state);
    expect(rows[0]?.childCount).toBe(2);
    expect(rows[1]?.isLastSibling).toBe(false);
    expect(rows[2]?.isLastSibling).toBe(true);
  });

  it('covers every node exactly once', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q1'],
      ['q4', 'q2'],
    ]);
    expect(linearize(state)).toHaveLength(nodeCount(state));
  });
});

describe('how far a row indents', () => {
  it('keeps a plain conversation flat', () => {
    // Every question follows the one before it, so there is nothing to
    // show with an indent. A staircase here would waste the whole width.
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q2'],
      ['q4', 'q3'],
    ]);
    expect(linearize(state).map((r) => r.indent)).toEqual([0, 0, 0, 0]);
    expect(linearize(state).map((r) => r.depth)).toEqual([0, 1, 2, 3]);
  });

  it('moves a row right only where the conversation splits', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q1'],
    ]);
    const rows = linearize(state);
    expect(rows.map((r) => r.indent)).toEqual([0, 1, 1]);
    expect(rows.map((r) => r.isBranch)).toEqual([false, true, true]);
  });

  it('keeps a run after a split at the same column', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q2'],
      ['q4', 'q1'],
    ]);
    const rows = linearize(state);
    expect(rows.map((r) => r.node.id)).toEqual(['q1', 'q2', 'q3', 'q4']);
    // q3 only continues q2, so it stays in q2's column.
    expect(rows.map((r) => r.indent)).toEqual([0, 1, 1, 1]);
    expect(rows.map((r) => r.isBranch)).toEqual([false, true, false, true]);
  });

  it('indents again for a split inside a split', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q2'],
      ['q4', 'q2'],
      ['q5', 'q1'],
    ]);
    const rows = linearize(state);
    expect(rows.map((r) => r.node.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
    expect(rows.map((r) => r.indent)).toEqual([0, 1, 2, 2, 1]);
  });

  it('never indents a root, however many there are', () => {
    // Most exchanges in a chat are tied to nothing, so they are all roots.
    // An indent must mean "this hangs under the row above", and nothing
    // else, or the whole panel drifts right and says nothing.
    const state = build([
      ['q1', null],
      ['q2', null],
      ['q3', null],
    ]);
    expect(linearize(state).map((r) => r.indent)).toEqual([0, 0, 0]);
  });

  it('indents the children of a node that has more than one', () => {
    const state = build([
      ['a', null],
      ['b', 'a'],
      ['c', 'a'],
      ['lonely', null],
    ]);
    const rows = linearize(state);
    expect(rows.map((r) => r.node.id)).toEqual(['a', 'b', 'c', 'lonely']);
    expect(rows.map((r) => r.indent)).toEqual([0, 1, 1, 0]);
  });

  it('gives one guide flag per indent column', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q2'],
      ['q4', 'q1'],
    ]);
    const rows = linearize(state);
    for (const row of rows) {
      expect(row.guides).toHaveLength(row.indent);
    }
    // q2 still has q4 below it, so its column needs a line.
    expect(rows.find((r) => r.node.id === 'q3')?.guides).toEqual([true]);
    // q4 is the last of its split, so nothing continues below it.
    expect(rows.find((r) => r.node.id === 'q4')?.guides).toEqual([false]);
  });
});

describe('subtreeIds', () => {
  it('includes the node itself and every node below it', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q2'],
      ['q4', 'q1'],
    ]);
    expect(subtreeIds(state, 'q1').sort()).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect(subtreeIds(state, 'q2').sort()).toEqual(['q2', 'q3']);
    expect(subtreeIds(state, 'ghost')).toEqual([]);
  });
});

describe('setLabel', () => {
  it('replaces the label', () => {
    const state = build([['q1', null]]);
    const after = must(setLabel(state, 'q1', 'a better title', 99));
    expect(after.nodes['q1']?.label).toBe('a better title');
  });

  it('rejects an unknown node', () => {
    const state = build([['q1', null]]);
    expect(errorOf(setLabel(state, 'ghost', 'x', 99))).toBe('NODE_NOT_FOUND');
  });
});

describe('repair', () => {
  it('leaves a sound tree untouched', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
    ]);
    const report = repair(state, 99);
    expect(report.fixes).toEqual([]);
    expect(report.state).toBe(state);
  });

  it('turns an orphan into a root', () => {
    const sound = build([['q1', null]]);
    const broken: TreeState = {
      ...sound,
      nodes: {
        ...sound.nodes,
        q2: { id: 'q2', parentId: 'gone', position: null, label: 'Q2', createdAt: 5, order: 0 },
      },
    };
    const report = repair(broken, 99);
    expect(report.state.nodes['q2']?.parentId).toBeNull();
    expect(report.fixes.join(' ')).toContain('q2');
  });

  it('breaks a cycle', () => {
    const sound = build([['q1', null]]);
    const broken: TreeState = {
      ...sound,
      nodes: {
        a: { id: 'a', parentId: 'b', position: null, label: 'A', createdAt: 5, order: 0 },
        b: { id: 'b', parentId: 'a', position: null, label: 'B', createdAt: 6, order: 0 },
      },
    };
    const report = repair(broken, 99);
    expect(report.fixes.length).toBeGreaterThan(0);
    // Every node must now reach a root, so pathToRoot must terminate.
    expect(pathToRoot(report.state, 'a').length).toBeGreaterThan(0);
    expect(getRoots(report.state).length).toBeGreaterThan(0);
    expect(linearize(report.state)).toHaveLength(2);
  });

  it('ignores the pending parent that an older stored tree held', () => {
    const sound = build([['q1', null]]);
    // An older tree held the parent the user chose for a question not yet
    // asked. That mode is gone. The field must not come back as a node.
    const stored = JSON.parse(serialize(sound)) as Record<string, unknown>;
    const raw = JSON.stringify({ ...stored, pendingParentId: 'gone' });
    const report = must(deserialize(raw, 99));
    expect(Object.keys(report.state.nodes)).toEqual(['q1']);
    expect('pendingParentId' in report.state).toBe(false);
  });
});

describe('persistence', () => {
  it('survives a round trip', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q1'],
    ]);
    const report = must(deserialize(serialize(state), 99));
    expect(report.fixes).toEqual([]);
    expect(report.state.nodes).toEqual(state.nodes);
    expect(report.state.conversationId).toBe('conv-1');
  });

  it('rejects text that is not JSON', () => {
    expect(errorOf(deserialize('{not json', 99))).toBe('BAD_PAYLOAD');
  });

  it('rejects another version', () => {
    expect(errorOf(deserialize(JSON.stringify({ version: 99 }), 99))).toBe('BAD_VERSION');
  });

  it('rejects a payload with no conversation id', () => {
    expect(errorOf(deserialize(JSON.stringify({ version: 1, nodes: {} }), 99))).toBe('BAD_PAYLOAD');
  });

  it('drops a node entry that has no id, and keeps the rest', () => {
    const raw = JSON.stringify({
      version: 1,
      conversationId: 'conv-1',
      nodes: {
        q1: { id: 'q1', parentId: null, position: null, label: 'Q1', createdAt: 1, order: 0 },
        junk: { label: 'no id here' },
      },
      pendingParentId: null,
      updatedAt: 1,
    });
    const report = must(deserialize(raw, 99));
    expect(Object.keys(report.state.nodes)).toEqual(['q1']);
  });

  it('fills a missing field with a safe default', () => {
    const raw = JSON.stringify({
      version: 1,
      conversationId: 'conv-1',
      nodes: { q1: { id: 'q1' } },
      updatedAt: 1,
    });
    const report = must(deserialize(raw, 42));
    expect(report.state.nodes['q1']).toEqual({
      id: 'q1',
      parentId: null,
      position: null,
      label: '(no label)',
      createdAt: 42,
      order: 0,
    });
  });
});

describe('where the page drew a node', () => {
  it('records the position when the node is added', () => {
    const now = clock();
    let state = createTree('c1', now());
    state = must(addNode(state, { id: 'q1', label: 'Q1', position: 8 }, null, now()));
    expect(state.nodes['q1']?.position).toBe(8);

    state = must(setPosition(state, 'q1', 12, now()));
    expect(state.nodes['q1']?.position).toBe(12);
  });

  it('leaves the state alone when the position has not moved', () => {
    const now = clock();
    let state = createTree('c1', now());
    state = must(addNode(state, { id: 'q1', label: 'Q1', position: 3 }, null, now()));
    expect(must(setPosition(state, 'q1', 3, now()))).toBe(state);
  });

  it('rejects a position for a node that is not there', () => {
    const state = build([['q1', null]]);
    expect(errorOf(setPosition(state, 'ghost', 1, 99))).toBe('NODE_NOT_FOUND');
  });

  it('sorts the roots into the order the page drew them', () => {
    const now = clock();
    let state = createTree('c1', now());
    // Added out of order, as happens when you scroll back through a chat.
    state = must(addNode(state, { id: 'late', label: 'late', position: 20 }, null, now()));
    state = must(addNode(state, { id: 'early', label: 'early', position: 4 }, null, now()));
    state = must(addNode(state, { id: 'middle', label: 'middle', position: 10 }, null, now()));
    expect(getRoots(state).map((n) => n.id)).toEqual(['early', 'middle', 'late']);
  });

  it('puts a node the page has not shown after the ones it has', () => {
    const now = clock();
    let state = createTree('c1', now());
    state = must(addNode(state, { id: 'unseen', label: 'unseen' }, null, now()));
    state = must(addNode(state, { id: 'seen', label: 'seen', position: 2 }, null, now()));
    expect(getRoots(state).map((n) => n.id)).toEqual(['seen', 'unseen']);
  });
});

describe('an older stored tree', () => {
  it('drops a link the extension guessed, and keeps one you made', () => {
    const raw = JSON.stringify({
      version: 1,
      conversationId: 'c1',
      nodes: {
        a: { id: 'a', parentId: null, parentSource: 'auto', label: 'A', createdAt: 1, order: 0 },
        b: { id: 'b', parentId: 'a', parentSource: 'auto', label: 'B', createdAt: 2, order: 0 },
        c: { id: 'c', parentId: 'a', parentSource: 'chosen', label: 'C', createdAt: 3, order: 1 },
      },
      pendingParentId: null,
      updatedAt: 3,
    });
    const report = must(deserialize(raw, 99));
    // The extension used to guess a link from the order of the page. Those
    // guesses moved about on their own, so they mean nothing now.
    expect(report.state.nodes['b']?.parentId).toBeNull();
    // A link you made is yours, so it stays.
    expect(report.state.nodes['c']?.parentId).toBe('a');
  });

  it('carries an old position field over', () => {
    const raw = JSON.stringify({
      version: 1,
      conversationId: 'c1',
      nodes: { a: { id: 'a', parentId: null, transcriptIndex: 14, label: 'A', createdAt: 1, order: 0 } },
      pendingParentId: null,
      updatedAt: 1,
    });
    const report = must(deserialize(raw, 99));
    expect(report.state.nodes['a']?.position).toBe(14);
  });
});

describe('isLinked', () => {
  it('calls a node with a parent linked', () => {
    expect(isLinked(build([['q1', null], ['q2', 'q1']]), 'q2')).toBe(true);
  });

  it('calls a node with children linked', () => {
    expect(isLinked(build([['q1', null], ['q2', 'q1']]), 'q1')).toBe(true);
  });

  it('calls a node on its own not linked', () => {
    expect(isLinked(build([['q1', null]]), 'q1')).toBe(false);
  });

  it('says no for a node that is not there', () => {
    expect(isLinked(build([['q1', null]]), 'ghost')).toBe(false);
  });
});

describe('hiding the nodes that stand alone', () => {
  it('leaves out a node with no link at all', () => {
    const state = build([
      ['q1', null],
      ['q2', 'q1'],
      ['alone', null],
    ]);
    expect(linearize(state).map((r) => r.node.id)).toEqual(['q1', 'q2', 'alone']);
    expect(linearize(state, { onlyLinked: true }).map((r) => r.node.id)).toEqual(['q1', 'q2']);
  });

  it('keeps every tree whole', () => {
    const state = build([
      ['a', null],
      ['b', 'a'],
      ['c', 'a'],
      ['lonely', null],
      ['d', null],
      ['e', 'd'],
    ]);
    expect(linearize(state, { onlyLinked: true }).map((r) => r.node.id))
      .toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('shows nothing when no node is linked', () => {
    expect(linearize(build([['a', null], ['b', null]]), { onlyLinked: true })).toEqual([]);
  });

  it('leaves the indent alone when the single ones are hidden', () => {
    const state = build([
      ['a', null],
      ['b', 'a'],
      ['x', null],
      ['y', null],
    ]);
    expect(linearize(state, { onlyLinked: true }).map((r) => r.indent)).toEqual([0, 0]);
    expect(linearize(state).map((r) => r.indent)).toEqual([0, 0, 0, 0]);
  });
});
