// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { TreePanel } from '../src/ui/panel.js';
import { addNode, createTree, linearize, type Result } from '../src/core/tree.js';

function must<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}


/** Callbacks that do nothing, for a test that does not press anything. */
function noCallbacks(): import('../src/ui/panel.js').PanelCallbacks {
  return {
    onJump: () => {},
    onBranch: () => {},
    onClearPending: () => {},
    onStartLink: () => {},
    onPickParent: () => {},
    onMakeRoot: () => {},
    onCancelLink: () => {},
    onToggleFilter: () => {},
    onLoadOlder: () => {},
    onToggle: () => {},
  };
}

/** The view fields a test does not care about. */
function viewExtras(): {
  linkingChildId: string | null;
  onlyLinked: boolean;
  totalCount: number;
  linkedCount: number;
} {
  return { linkingChildId: null, onlyLinked: false, totalCount: 0, linkedCount: 0 };
}

/** Read the indent the panel drew, the way the verify script reads it. */
function drawnDepths(): number[] {
  const host = document.getElementById('claude-tree-panel-host');
  const root = host?.shadowRoot;
  if (root === undefined || root === null) throw new Error('no shadow root');
  return Array.from(root.querySelectorAll('.panel .row')).map((row) => {
    const spacers = row.querySelectorAll('.g').length;
    const elbow = row.querySelector('.elbow') === null ? 0 : 1;
    return spacers + elbow;
  });
}

function mountWith(pairs: ReadonlyArray<readonly [string, string | null]>): void {
  document.body.innerHTML = '';
  let state = createTree('c1', 1);
  let t = 1;
  for (const [id, parentId] of pairs) {
    state = must(addNode(state, { id, label: id }, parentId, ++t));
  }
  const panel = new TreePanel({
    ...noCallbacks(),
  });
  panel.mount(document.body);
  panel.render({
    rows: linearize(state),
    pendingParentId: null,
    activeTurnId: null,
    notice: null,
    coverage: null,
    ...viewExtras(),
  });
}

describe('the columns the panel draws', () => {
  it('draws no column for a conversation with no branch', () => {
    mountWith([['q1', null], ['q2', 'q1'], ['q3', 'q2']]);
    expect(drawnDepths()).toEqual([0, 0, 0]);
  });

  it('draws one column for each side of a split', () => {
    mountWith([['q1', null], ['q2', 'q1'], ['q3', 'q1']]);
    expect(drawnDepths()).toEqual([0, 1, 1]);
  });

  it('keeps a run after a split in the same column', () => {
    mountWith([['q1', null], ['q2', 'q1'], ['q3', 'q2'], ['q4', 'q1']]);
    expect(drawnDepths()).toEqual([0, 1, 1, 1]);
  });

  it('draws a second column for a split inside a split', () => {
    mountWith([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q2'],
      ['q4', 'q2'],
      ['q5', 'q1'],
    ]);
    expect(drawnDepths()).toEqual([0, 1, 2, 2, 1]);
  });

  it('never draws more columns than the row indents', () => {
    mountWith([
      ['q1', null],
      ['q2', 'q1'],
      ['q3', 'q2'],
      ['q4', 'q1'],
      ['q5', null],
    ]);
    const root = document.getElementById('claude-tree-panel-host')!.shadowRoot!;
    const rows = Array.from(root.querySelectorAll('.panel .row'));
    for (const row of rows) {
      const columns = row.querySelectorAll('.g').length
        + (row.querySelector('.elbow') === null ? 0 : 1);
      expect(columns).toBeLessThanOrEqual(3);
    }
  });

  it('shows the label as text, never as markup', () => {
    document.body.innerHTML = '';
    let state = createTree('c1', 1);
    state = must(addNode(state, { id: 'q1', label: '<img src=x onerror=alert(1)>' }, null, 2));
    const panel = new TreePanel({
      ...noCallbacks(),
    });
    panel.mount(document.body);
    panel.render({ rows: linearize(state), pendingParentId: null, activeTurnId: null, notice: null, coverage: null, ...viewExtras() });
    const root = document.getElementById('claude-tree-panel-host')?.shadowRoot;
    expect(root?.querySelectorAll('img').length).toBe(0);
    expect(root?.querySelector('.panel .jump .text')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('the strips that the panel can hide', () => {
  function mountPanel(view: Parameters<TreePanel['render']>[0]): ShadowRoot {
    document.body.innerHTML = '';
    const panel = new TreePanel({
      ...noCallbacks(),
    });
    panel.mount(document.body);
    panel.render(view);
    const root = document.getElementById('claude-tree-panel-host')?.shadowRoot;
    if (root === undefined || root === null) throw new Error('no shadow root');
    return root;
  }

  it('marks the choice strip hidden when nothing is chosen', () => {
    const root = mountPanel({ rows: [], pendingParentId: null, activeTurnId: null, notice: null, coverage: null, ...viewExtras() });
    const pending = root.querySelector('.panel .pending') as HTMLElement;
    expect(pending.hidden).toBe(true);
    // The stylesheet sets `display: flex` on this strip, which beats the
    // browser's own rule for the hidden attribute. The stylesheet must say
    // so again, or a cancelled choice keeps showing.
    const style = root.querySelector('style')?.textContent ?? '';
    expect(style).toContain('.pending[hidden]');
    expect(style).toContain('.notice[hidden]');
  });

  it('marks the notice strip hidden when there is no notice', () => {
    const root = mountPanel({ rows: [], pendingParentId: null, activeTurnId: null, notice: null, coverage: null, ...viewExtras() });
    expect((root.querySelector('.panel .notice') as HTMLElement).hidden).toBe(true);
  });

  it('shows the notice strip when there is a notice', () => {
    const root = mountPanel({ rows: [], pendingParentId: null, activeTurnId: null, notice: 'something happened', coverage: null, ...viewExtras() });
    const notice = root.querySelector('.panel .notice') as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.querySelector('.noticetext')?.textContent).toBe('something happened');
  });

  it('shows the choice strip, with the label, when a node is chosen', () => {
    let state = createTree('c1', 1);
    state = must(addNode(state, { id: 'q1', label: 'the chosen question' }, null, 2));
    const root = mountPanel({
      rows: linearize(state), pendingParentId: 'q1', activeTurnId: null, notice: null,
      coverage: null,
      ...viewExtras(),
    });
    const pending = root.querySelector('.panel .pending') as HTMLElement;
    expect(pending.hidden).toBe(false);
    expect(pending.querySelector('.label')?.textContent).toBe('the chosen question');
  });
});

describe('class names must not collide', () => {
  it('the floating button and the choice strip use different classes', () => {
    document.body.innerHTML = '';
    let state = createTree('c1', 1);
    state = must(addNode(state, { id: 'q1', label: 'chosen one' }, null, 2));
    const panel = new TreePanel({
      ...noCallbacks(),
    });
    panel.mount(document.body);
    panel.render({ rows: linearize(state), pendingParentId: 'q1', activeTurnId: null, notice: null, coverage: null, ...viewExtras() });
    const root = document.getElementById('claude-tree-panel-host')!.shadowRoot!;

    // Exactly one element may answer to `.pending`, or every reader of the
    // panel, including the verify script, picks up the wrong element.
    expect(root.querySelectorAll('.pending')).toHaveLength(1);
    expect((root.querySelector('.pending') as HTMLElement).className).toBe('pending');
    expect(root.querySelector('.toggle')?.classList.contains('choosing')).toBe(true);
  });
});

describe('the strip that says the tree may be short', () => {
  function mountPanel(view: Parameters<TreePanel['render']>[0]): ShadowRoot {
    document.body.innerHTML = '';
    const panel = new TreePanel({
      ...noCallbacks(),
    });
    panel.mount(document.body);
    panel.render(view);
    const root = document.getElementById('claude-tree-panel-host')?.shadowRoot;
    if (root === undefined || root === null) throw new Error('no shadow root');
    return root;
  }

  const base = {
    rows: [], pendingParentId: null, activeTurnId: null, notice: null,
    linkingChildId: null, onlyLinked: false, totalCount: 0, linkedCount: 0,
  };

  it('warns while older messages may still exist', () => {
    const root = mountPanel({
      ...base,
      coverage: { drawnRows: 4, loadedMessages: 32, olderMayExist: true, loading: false },
    });
    const notice = root.querySelector('.panel .notice') as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.querySelector('.noticetext')?.textContent).toContain('older exchanges');
    expect((root.querySelector('.loadolder') as HTMLButtonElement).hidden).toBe(false);
  });

  it('says nothing once no older message is left', () => {
    const root = mountPanel({
      ...base,
      coverage: { drawnRows: 6, loadedMessages: 6, olderMayExist: false, loading: false },
    });
    expect((root.querySelector('.panel .notice') as HTMLElement).hidden).toBe(true);
    expect((root.querySelector('.loadolder') as HTMLButtonElement).hidden).toBe(true);
  });

  it('turns the button off while it is loading', () => {
    const root = mountPanel({
      ...base,
      coverage: { drawnRows: 4, loadedMessages: 32, olderMayExist: true, loading: true },
    });
    const button = root.querySelector('.loadolder') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(root.querySelector('.noticetext')?.textContent).toContain('reading');
  });

  it('calls back when you press the button', () => {
    document.body.innerHTML = '';
    let pressed = 0;
    const panel = new TreePanel({
      ...noCallbacks(), onLoadOlder: () => { pressed++; },
    });
    panel.mount(document.body);
    panel.render({
      ...base,
      coverage: { drawnRows: 4, loadedMessages: 32, olderMayExist: true, loading: false },
    });
    const root = document.getElementById('claude-tree-panel-host')!.shadowRoot!;
    (root.querySelector('.loadolder') as HTMLButtonElement).click();
    expect(pressed).toBe(1);
  });

  it('lets a real notice win over the coverage line', () => {
    const root = mountPanel({
      ...base,
      notice: 'something went wrong',
      coverage: { drawnRows: 4, loadedMessages: 32, olderMayExist: true, loading: false },
    });
    expect(root.querySelector('.noticetext')?.textContent).toBe('something went wrong');
  });
});

describe('the structure the panel states in its markup', () => {
  it('states the depth, the indent and the root of every row', () => {
    mountWith([['q1', null], ['q2', 'q1'], ['q3', 'q1'], ['q4', 'q2']]);
    const root = document.getElementById('claude-tree-panel-host')!.shadowRoot!;
    const rows = Array.from(root.querySelectorAll<HTMLElement>('.panel .row'));
    expect(rows.map((r) => r.dataset.depth)).toEqual(['0', '1', '2', '1']);
    expect(rows.map((r) => r.dataset.indent)).toEqual(['0', '1', '1', '1']);
    expect(rows.map((r) => r.dataset.root)).toEqual(['true', 'false', 'false', 'false']);
    expect(rows.map((r) => r.dataset.children)).toEqual(['2', '1', '0', '0']);
  });

  it('tells a flat drawing of one chain apart from a forest', () => {
    // Both draw no indent column. Only the stated structure separates them.
    mountWith([['q1', null], ['q2', 'q1'], ['q3', 'q2']]);
    const chain = Array.from(
      document.getElementById('claude-tree-panel-host')!.shadowRoot!
        .querySelectorAll<HTMLElement>('.panel .row'),
    );
    expect(chain.filter((r) => r.dataset.root === 'true')).toHaveLength(1);
    expect(chain.map((r) => r.dataset.depth)).toEqual(['0', '1', '2']);

    mountWith([['q1', null], ['q2', null], ['q3', null]]);
    const forest = Array.from(
      document.getElementById('claude-tree-panel-host')!.shadowRoot!
        .querySelectorAll<HTMLElement>('.panel .row'),
    );
    expect(forest.filter((r) => r.dataset.root === 'true')).toHaveLength(3);
    expect(forest.map((r) => r.dataset.depth)).toEqual(['0', '0', '0']);
  });

  it('names the exchange each row stands for', () => {
    mountWith([['q1', null], ['q2', 'q1']]);
    const rows = Array.from(
      document.getElementById('claude-tree-panel-host')!.shadowRoot!
        .querySelectorAll<HTMLElement>('.panel .row'),
    );
    expect(rows.map((r) => r.dataset.turn)).toEqual(['q1', 'q2']);
  });
});

describe('linking an exchange after the event', () => {
  function mount(view: Parameters<TreePanel['render']>[0], calls: Partial<import('../src/ui/panel.js').PanelCallbacks> = {}): ShadowRoot {
    document.body.innerHTML = '';
    const panel = new TreePanel({ ...noCallbacks(), ...calls });
    panel.mount(document.body);
    panel.render(view);
    const root = document.getElementById('claude-tree-panel-host')?.shadowRoot;
    if (root === undefined || root === null) throw new Error('no shadow root');
    return root;
  }

  function treeOf(pairs: ReadonlyArray<readonly [string, string | null]>) {
    let state = createTree('c1', 1);
    let t = 1;
    for (const [id, parentId] of pairs) {
      state = must(addNode(state, { id, label: id }, parentId, ++t));
    }
    return state;
  }

  const base = {
    pendingParentId: null, activeTurnId: null, notice: null, coverage: null,
    onlyLinked: false, totalCount: 3, linkedCount: 0,
  };

  it('offers link on a node with no parent, and relink on one with a parent', () => {
    const state = treeOf([['a', null], ['b', 'a']]);
    const root = mount({ ...base, rows: linearize(state), linkingChildId: null });
    const labels = Array.from(root.querySelectorAll('.panel .row .link')).map((b) => b.textContent);
    expect(labels).toEqual(['link', 'relink']);
  });

  it('asks for a parent once a link is open', () => {
    const state = treeOf([['a', null], ['b', null]]);
    const root = mount({ ...base, rows: linearize(state), linkingChildId: 'b' });
    const strip = root.querySelector('.panel .linking') as HTMLElement;
    expect(strip.hidden).toBe(false);
    expect(strip.querySelector('.label')?.textContent).toBe('b');
  });

  it('turns every other row into a target', () => {
    const state = treeOf([['a', null], ['b', null], ['c', null]]);
    const root = mount({ ...base, rows: linearize(state), linkingChildId: 'b' });
    const rows = Array.from(root.querySelectorAll<HTMLElement>('.panel .row'));
    expect(rows.map((r) => r.dataset.turn)).toEqual(['a', 'b', 'c']);
    expect(rows.map((r) => r.classList.contains('target'))).toEqual([true, false, true]);
    expect(rows.map((r) => r.classList.contains('linking-self'))).toEqual([false, true, false]);
  });

  it('reports the parent you pick', () => {
    const state = treeOf([['a', null], ['b', null]]);
    let picked: string | null = null;
    const root = mount(
      { ...base, rows: linearize(state), linkingChildId: 'b' },
      { onPickParent: (id) => { picked = id; } },
    );
    (root.querySelector('.panel .row[data-turn="a"] .branch') as HTMLButtonElement).click();
    expect(picked).toBe('a');
  });

  it('picks a parent when you click the text as well', () => {
    const state = treeOf([['a', null], ['b', null]]);
    let picked: string | null = null;
    let jumped = 0;
    const root = mount(
      { ...base, rows: linearize(state), linkingChildId: 'b' },
      { onPickParent: (id) => { picked = id; }, onJump: () => { jumped++; } },
    );
    (root.querySelector('.panel .row[data-turn="a"] .jump') as HTMLButtonElement).click();
    expect(picked).toBe('a');
    expect(jumped).toBe(0);
  });

  it('still jumps when no link is open', () => {
    const state = treeOf([['a', null], ['b', null]]);
    let jumped: string | null = null;
    const root = mount(
      { ...base, rows: linearize(state), linkingChildId: null },
      { onJump: (id) => { jumped = id; } },
    );
    (root.querySelector('.panel .row[data-turn="a"] .jump') as HTMLButtonElement).click();
    expect(jumped).toBe('a');
  });

  it('offers to leave the exchange with no parent at all', () => {
    const state = treeOf([['a', null], ['b', 'a']]);
    let rooted = 0;
    const root = mount(
      { ...base, rows: linearize(state), linkingChildId: 'b' },
      { onMakeRoot: () => { rooted++; } },
    );
    (root.querySelector('.panel .linking .makeroot') as HTMLButtonElement).click();
    expect(rooted).toBe(1);
  });

  it('lets you give up on the link', () => {
    const state = treeOf([['a', null], ['b', null]]);
    let cancelled = 0;
    const root = mount(
      { ...base, rows: linearize(state), linkingChildId: 'b' },
      { onCancelLink: () => { cancelled++; } },
    );
    (root.querySelector('.panel .linking .cancellink') as HTMLButtonElement).click();
    expect(cancelled).toBe(1);
  });
});

describe('the filter that hides what stands alone', () => {
  function mount(view: Parameters<TreePanel['render']>[0], calls: Partial<import('../src/ui/panel.js').PanelCallbacks> = {}): ShadowRoot {
    document.body.innerHTML = '';
    const panel = new TreePanel({ ...noCallbacks(), ...calls });
    panel.mount(document.body);
    panel.render(view);
    const root = document.getElementById('claude-tree-panel-host')?.shadowRoot;
    if (root === undefined || root === null) throw new Error('no shadow root');
    return root;
  }

  const base = {
    rows: [], pendingParentId: null, activeTurnId: null, notice: null,
    coverage: null, linkingChildId: null,
  };

  it('counts every exchange while it shows them all', () => {
    const root = mount({ ...base, onlyLinked: false, totalCount: 12, linkedCount: 4 });
    expect(root.querySelector('.panel .meta')?.textContent).toBe('12 exchanges');
    expect(root.querySelector('.panel .filter')?.textContent).toBe('all');
  });

  it('counts the linked ones while it hides the rest', () => {
    const root = mount({ ...base, onlyLinked: true, totalCount: 12, linkedCount: 4 });
    expect(root.querySelector('.panel .meta')?.textContent).toBe('4 of 12');
    expect(root.querySelector('.panel .filter')?.textContent).toBe('linked');
  });

  it('reports a press of the filter', () => {
    let pressed = 0;
    const root = mount(
      { ...base, onlyLinked: false, totalCount: 0, linkedCount: 0 },
      { onToggleFilter: () => { pressed++; } },
    );
    (root.querySelector('.panel .filter') as HTMLButtonElement).click();
    expect(pressed).toBe(1);
  });

  it('explains an empty filtered view differently', () => {
    const root = mount({ ...base, onlyLinked: true, totalCount: 9, linkedCount: 0 });
    expect(root.querySelector('.panel .empty')?.textContent).toContain('Nothing is tied together');
  });
});
