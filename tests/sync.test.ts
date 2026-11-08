import { describe, expect, it } from 'vitest';
import {
  createTree,
  getChildren,
  getRoots,
  nodeCount,
  pathToRoot,
  removeNode,
  setParent,
  setPendingParent,
  type Result,
  type TreeState,
} from '../src/core/tree.js';
import { PLACEHOLDER_LABEL, syncWithTranscript, type SyncInput } from '../src/core/sync.js';

function must<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function clock(start = 1000): () => number {
  let t = start;
  return () => ++t;
}

/** An exchange list, as the adapter hands it over. */
function page(...ids: readonly string[]): SyncInput[] {
  return ids.map((id, i) => ({ turnId: id, questionText: `the text of ${id}`, index: i * 2 }));
}

describe('an exchange you did not tie to anything', () => {
  it('stands on its own', () => {
    const now = clock();
    const result = syncWithTranscript(createTree('c1', now()), page('q1'), now());
    expect(result.added).toEqual(['q1']);
    expect(result.state.nodes['q1']?.parentId).toBeNull();
  });

  it('stays on its own however many more arrive', () => {
    // This is the heart of the design. The extension never works out which
    // exchange follows which. Every guess it used to make was wrong sooner
    // or later, because claude.ai draws only part of a long conversation.
    const now = clock();
    const result = syncWithTranscript(createTree('c1', now()), page('q1', 'q2', 'q3'), now());
    expect(result.added).toEqual(['q1', 'q2', 'q3']);
    expect(getRoots(result.state).map((n) => n.id)).toEqual(['q1', 'q2', 'q3']);
    for (const id of ['q1', 'q2', 'q3']) {
      expect(result.state.nodes[id]?.parentId).toBeNull();
    }
  });

  it('takes its label from the question text', () => {
    const now = clock();
    const result = syncWithTranscript(createTree('c1', now()), [
      { turnId: 'q1', questionText: 'how  do\n I   start?' },
    ], now());
    expect(result.state.nodes['q1']?.label).toBe('how do I start?');
  });

  it('adds nothing on a second pass over the same page', () => {
    const now = clock();
    const first = syncWithTranscript(createTree('c1', now()), page('q1', 'q2'), now());
    const second = syncWithTranscript(first.state, page('q1', 'q2'), now());
    expect(second.added).toEqual([]);
    expect(second.relabelled).toEqual([]);
    expect(nodeCount(second.state)).toBe(2);
  });
});

describe('the exchange you chose a parent for', () => {
  it('hangs under the node you picked', () => {
    const now = clock();
    let state: TreeState = syncWithTranscript(createTree('c1', now()), page('q1', 'q2'), now()).state;

    state = must(setPendingParent(state, 'q1', now()));
    const result = syncWithTranscript(state, page('q1', 'q2', 'q3'), now());

    expect(result.added).toEqual(['q3']);
    expect(pathToRoot(result.state, 'q3').map((n) => n.id)).toEqual(['q1', 'q3']);
  });

  it('builds the three sibling follow-ups you wanted', () => {
    const now = clock();
    let state: TreeState = syncWithTranscript(createTree('c1', now()), page('q1'), now()).state;

    const shown = ['q1'];
    for (const id of ['q2', 'q3', 'q4']) {
      state = must(setPendingParent(state, 'q1', now()));
      shown.push(id);
      state = syncWithTranscript(state, page(...shown), now()).state;
    }

    expect(getChildren(state, 'q1').map((n) => n.id)).toEqual(['q2', 'q3', 'q4']);
    for (const id of ['q2', 'q3', 'q4']) {
      expect(pathToRoot(state, id).map((n) => n.id)).toEqual(['q1', id]);
    }
  });

  it('spends the choice on one question only', () => {
    const now = clock();
    let state: TreeState = syncWithTranscript(createTree('c1', now()), page('q1', 'q2'), now()).state;
    state = must(setPendingParent(state, 'q1', now()));

    state = syncWithTranscript(state, page('q1', 'q2', 'q3'), now()).state;
    expect(state.pendingParentId).toBeNull();

    // The next one has no choice behind it, so it stands on its own.
    state = syncWithTranscript(state, page('q1', 'q2', 'q3', 'q4'), now()).state;
    expect(state.nodes['q4']?.parentId).toBeNull();
  });

  it('gives the choice to the first new exchange only', () => {
    const now = clock();
    let state: TreeState = syncWithTranscript(createTree('c1', now()), page('q1'), now()).state;
    state = must(setPendingParent(state, 'q1', now()));

    const result = syncWithTranscript(state, page('q1', 'q2', 'q3'), now());
    expect(result.added).toEqual(['q2', 'q3']);
    expect(result.state.nodes['q2']?.parentId).toBe('q1');
    expect(result.state.nodes['q3']?.parentId).toBeNull();
  });

  it('keeps your choice while you have not asked anything yet', () => {
    const now = clock();
    let state: TreeState = syncWithTranscript(createTree('c1', now()), page('q1', 'q2'), now()).state;
    state = must(setPendingParent(state, 'q1', now()));

    for (let i = 0; i < 3; i++) {
      state = syncWithTranscript(state, page('q1', 'q2'), now()).state;
      expect(state.pendingParentId).toBe('q1');
    }
  });

  it('ignores a choice whose node you deleted, and says so', () => {
    const now = clock();
    let state: TreeState = syncWithTranscript(createTree('c1', now()), page('q1', 'q2'), now()).state;
    state = { ...must(removeNode(state, 'q1', { cascade: false }, now())), pendingParentId: 'q1' };

    const result = syncWithTranscript(state, page('q2', 'q3'), now());
    expect(result.problems.join(' ')).toContain('q1');
    expect(result.state.nodes['q3']?.parentId).toBeNull();
  });
});

describe('a link never moves on its own', () => {
  it('survives any number of later reads', () => {
    const now = clock();
    let state: TreeState = syncWithTranscript(createTree('c1', now()), page('q1', 'q2'), now()).state;
    state = must(setParent(state, 'q2', 'q1', now()));

    for (let i = 0; i < 10; i++) {
      state = syncWithTranscript(state, page('q1', 'q2'), now()).state;
    }
    expect(pathToRoot(state, 'q2').map((n) => n.id)).toEqual(['q1', 'q2']);
  });

  it('survives a page that shows the rows in another order', () => {
    const now = clock();
    let state: TreeState = syncWithTranscript(createTree('c1', now()), page('q1', 'q2', 'q3'), now()).state;
    state = must(setParent(state, 'q3', 'q1', now()));

    // claude.ai drops rows and renumbers them. None of that touches a link.
    state = syncWithTranscript(state, [
      { turnId: 'q3', questionText: 'the text of q3', index: 0 },
      { turnId: 'q1', questionText: 'the text of q1', index: 40 },
    ], now()).state;

    expect(pathToRoot(state, 'q3').map((n) => n.id)).toEqual(['q1', 'q3']);
  });

  it('survives a page that shows only part of the conversation', () => {
    const now = clock();
    let state: TreeState = syncWithTranscript(createTree('c1', now()), page('q1', 'q2', 'q3'), now()).state;
    state = must(setParent(state, 'q3', 'q1', now()));

    const result = syncWithTranscript(state, [
      { turnId: 'q3', questionText: 'the text of q3', index: 4 },
    ], now());
    expect(result.added).toEqual([]);
    expect(nodeCount(result.state)).toBe(3);
    expect(pathToRoot(result.state, 'q3').map((n) => n.id)).toEqual(['q1', 'q3']);
  });

  it('survives a read taken while the page was still changing', () => {
    const now = clock();
    let state: TreeState = syncWithTranscript(createTree('c1', now()), page('a', 'b', 'c'), now()).state;
    state = must(setParent(state, 'c', 'a', now()));

    for (let i = 0; i < 20; i++) {
      state = syncWithTranscript(state, [
        { turnId: 'a', questionText: 'the text of a', index: null },
        { turnId: 'c', questionText: 'the text of c', index: 6 + i },
      ], now()).state;
    }
    expect(pathToRoot(state, 'c').map((n) => n.id)).toEqual(['a', 'c']);
  });
});

describe('a label that arrives late', () => {
  it('holds a placeholder until the text renders', () => {
    const now = clock();
    const result = syncWithTranscript(createTree('c1', now()), [
      { turnId: 'q1', questionText: '' },
    ], now());
    expect(result.state.nodes['q1']?.label).toBe(PLACEHOLDER_LABEL);
  });

  it('fills the label in on a later pass', () => {
    const now = clock();
    const first = syncWithTranscript(createTree('c1', now()), [
      { turnId: 'q1', questionText: '' },
    ], now());
    const second = syncWithTranscript(first.state, [
      { turnId: 'q1', questionText: 'the real question' },
    ], now());
    expect(second.relabelled).toEqual(['q1']);
    expect(second.state.nodes['q1']?.label).toBe('the real question');
  });

  it('never overwrites a label that is already real', () => {
    const now = clock();
    const first = syncWithTranscript(createTree('c1', now()), [
      { turnId: 'q1', questionText: 'the first text' },
    ], now());
    const second = syncWithTranscript(first.state, [
      { turnId: 'q1', questionText: 'something else entirely' },
    ], now());
    expect(second.relabelled).toEqual([]);
    expect(second.state.nodes['q1']?.label).toBe('the first text');
  });
});

describe('the sorting number', () => {
  it('records where the page drew each exchange', () => {
    const now = clock();
    const state = syncWithTranscript(createTree('c1', now()), page('q1', 'q2', 'q3'), now()).state;
    expect(state.nodes['q1']?.position).toBe(0);
    expect(state.nodes['q2']?.position).toBe(2);
    expect(state.nodes['q3']?.position).toBe(4);
  });

  it('follows the page when claude.ai renumbers the rows', () => {
    const now = clock();
    let state = syncWithTranscript(createTree('c1', now()), [
      { turnId: 'q1', questionText: 'one', index: 0 },
    ], now()).state;
    state = syncWithTranscript(state, [
      { turnId: 'q1', questionText: 'one', index: 6 },
    ], now()).state;
    expect(state.nodes['q1']?.position).toBe(6);
  });

  it('puts the roots in reading order, however they arrived', () => {
    const now = clock();
    // You scroll back, so the older exchanges reach the tree last.
    let state = syncWithTranscript(createTree('c1', now()), [
      { turnId: 'late', questionText: 'late', index: 20 },
    ], now()).state;
    state = syncWithTranscript(state, [
      { turnId: 'early', questionText: 'early', index: 2 },
      { turnId: 'late', questionText: 'late', index: 20 },
    ], now()).state;
    expect(getRoots(state).map((n) => n.id)).toEqual(['early', 'late']);
  });
});

describe('an empty page', () => {
  it('changes nothing', () => {
    const now = clock();
    const state = createTree('c1', now());
    const result = syncWithTranscript(state, [], now());
    expect(result.added).toEqual([]);
    expect(result.state).toBe(state);
  });
});
