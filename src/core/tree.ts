/**
 * The conversation tree model.
 *
 * A node is one exchange: one user message plus the reply to it.
 * A node knows its parent. The parent is the exchange that this question
 * depends on. The parent is not always the exchange that came before it in
 * time, and that difference is the whole point of this extension.
 *
 * This module is pure. It never touches the DOM, the network, or storage.
 * Every operation returns a new state and never changes the one you pass in.
 */

export const TREE_VERSION = 1 as const;

/** The maximum length of a node label. */
export const LABEL_MAX = 48;

export interface TreeNode {
  /** The message id that claude.ai gave to the user message of this exchange. */
  readonly id: string;
  /**
   * The exchange this one depends on. `null` means the node is a root.
   *
   * Only you set this, by choosing a parent in the panel. The extension
   * never guesses it from the order of the page. Every guess it used to
   * make was wrong sooner or later, because claude.ai draws only part of
   * a long conversation and renumbers the rows as it loads more.
   */
  readonly parentId: string | null;
  /**
   * Where claude.ai last drew this exchange in the conversation.
   *
   * This is for sorting the roots into reading order, and for nothing
   * else. The number moves every time claude.ai loads older messages, so
   * it never means anything on its own. A wrong value makes the list look
   * odd for a moment. It can never break a link, because no link is ever
   * read from it.
   */
  readonly position: number | null;
  /** A short title for the tree panel. It comes from the user message. */
  readonly label: string;
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
  /** The position among siblings. Lower comes first. */
  readonly order: number;
}

export interface TreeState {
  readonly version: typeof TREE_VERSION;
  /** The claude.ai conversation uuid that owns this tree. */
  readonly conversationId: string;
  readonly nodes: Readonly<Record<string, TreeNode>>;
  /**
   * The node you selected as the parent of your next question.
   * `null` means the next question attaches to the newest node.
   */
  readonly pendingParentId: string | null;
  readonly updatedAt: number;
}

export type TreeErrorCode =
  | 'DUPLICATE_NODE'
  | 'NODE_NOT_FOUND'
  | 'PARENT_NOT_FOUND'
  | 'SELF_PARENT'
  | 'WOULD_CREATE_CYCLE'
  | 'BAD_VERSION'
  | 'BAD_PAYLOAD';

export interface TreeError {
  readonly code: TreeErrorCode;
  readonly message: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TreeError };

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err<T>(code: TreeErrorCode, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

export interface NewNode {
  readonly id: string;
  readonly label: string;
  /** Omit to use `now`. */
  readonly createdAt?: number;
  /** Where claude.ai drew the exchange, for sorting only. */
  readonly position?: number | null;
}

// --------------------------------------------------------------- creation

export function createTree(conversationId: string, now: number): TreeState {
  return {
    version: TREE_VERSION,
    conversationId,
    nodes: {},
    pendingParentId: null,
    updatedAt: now,
  };
}

export function isEmpty(state: TreeState): boolean {
  return Object.keys(state.nodes).length === 0;
}

export function nodeCount(state: TreeState): number {
  return Object.keys(state.nodes).length;
}

export function getNode(state: TreeState, id: string): TreeNode | null {
  return state.nodes[id] ?? null;
}

// ----------------------------------------------------------------- labels

/**
 * Turn a user message into a short label.
 * It collapses every run of whitespace into one space.
 */
export function deriveLabel(text: string, max: number = LABEL_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '(empty)';
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + '…';
}

// ------------------------------------------------------------ inspection

function siblingsOf(state: TreeState, parentId: string | null): TreeNode[] {
  const list: TreeNode[] = [];
  for (const node of Object.values(state.nodes)) {
    if (node.parentId === parentId) list.push(node);
  }
  return list;
}

function nextOrder(state: TreeState, parentId: string | null): number {
  let max = -1;
  for (const node of siblingsOf(state, parentId)) {
    if (node.order > max) max = node.order;
  }
  return max + 1;
}

/**
 * The display order of two nodes that share a parent.
 *
 * Reading order comes first, because the panel is also a map of the chat.
 * A node the page has not shown yet falls back to when the tree first saw
 * it, and then to its id, so the order never flickers.
 */
function bySortKey(a: TreeNode, b: TreeNode): number {
  const pa = a.position;
  const pb = b.position;
  if (pa !== null && pb !== null && pa !== pb) return pa - pb;
  if (pa !== null && pb === null) return -1;
  if (pa === null && pb !== null) return 1;
  if (a.order !== b.order) return a.order - b.order;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The children of `parentId`, in display order. Pass `null` for the roots. */
export function getChildren(state: TreeState, parentId: string | null): TreeNode[] {
  return siblingsOf(state, parentId).sort(bySortKey);
}

export function getRoots(state: TreeState): TreeNode[] {
  return getChildren(state, null);
}

/** The newest node by creation time. This is the default parent. */
export function lastAddedNode(state: TreeState): TreeNode | null {
  let best: TreeNode | null = null;
  for (const node of Object.values(state.nodes)) {
    if (best === null) {
      best = node;
      continue;
    }
    if (node.createdAt > best.createdAt) best = node;
    else if (node.createdAt === best.createdAt && node.id > best.id) best = node;
  }
  return best;
}

/**
 * The parent that a new question gets when you do not choose one.
 * It is the pending parent if you set one, otherwise the newest node.
 */
export function effectiveParentId(state: TreeState): string | null {
  const pending = state.pendingParentId;
  if (pending !== null && state.nodes[pending] !== undefined) return pending;
  const last = lastAddedNode(state);
  return last === null ? null : last.id;
}

/**
 * Every ancestor of `id`, from the root down to `id` itself.
 * It returns an empty array when `id` is unknown.
 * It stops safely if the stored data holds a cycle.
 */
export function pathToRoot(state: TreeState, id: string): TreeNode[] {
  const chain: TreeNode[] = [];
  const seen = new Set<string>();
  let current = state.nodes[id];
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    const parentId = current.parentId;
    current = parentId === null ? undefined : state.nodes[parentId];
  }
  chain.reverse();
  return chain;
}

export function isDescendantOf(state: TreeState, id: string, maybeAncestorId: string): boolean {
  const seen = new Set<string>();
  let current = state.nodes[id];
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    const parentId = current.parentId;
    if (parentId === maybeAncestorId) return true;
    current = parentId === null ? undefined : state.nodes[parentId];
  }
  return false;
}

export interface FlatRow {
  readonly node: TreeNode;
  /** How many parents sit above this node. 0 for a root. */
  readonly depth: number;
  /**
   * How many columns the panel must indent this row.
   *
   * This is not `depth`. A run of questions with no branch is one straight
   * line, and drawing it as a staircase wastes the whole width of the
   * panel and tells the reader nothing. So a node that is an only child
   * sits level with its parent, and a row moves right only where the
   * conversation really splits.
   */
  readonly indent: number;
  readonly childCount: number;
  /** True when this node is the last child of its parent. */
  readonly isLastSibling: boolean;
  /** True when this node shares its parent with another node. */
  readonly isBranch: boolean;
  /**
   * One entry per indent column, from the outside in.
   * `true` means that column still has a row below it in the same branch,
   * so the panel must draw a vertical line there.
   */
  readonly guides: readonly boolean[];
}

/**
 * Flatten the tree into display rows, depth first.
 * The tree panel renders this list directly.
 */
export interface LinearizeOptions {
  /**
   * Leave out every node that stands alone.
   *
   * Most exchanges in a long chat have no link, because you never tied
   * them to anything. They are still listed, so that you can tie them up
   * later, but they can also be hidden to leave only the shape you built.
   * A node that stands alone has no children either, so hiding it never
   * breaks a tree.
   */
  readonly onlyLinked?: boolean;
}

/** True when this node takes part in a link, either way round. */
export function isLinked(state: TreeState, id: string): boolean {
  const node = state.nodes[id];
  if (node === undefined) return false;
  if (node.parentId !== null) return true;
  return getChildren(state, id).length > 0;
}

export function linearize(state: TreeState, options: LinearizeOptions = {}): FlatRow[] {
  const onlyLinked = options.onlyLinked ?? false;
  const rows: FlatRow[] = [];
  const visited = new Set<string>();

  const walk = (
    parentId: string | null,
    depth: number,
    indent: number,
    guides: readonly boolean[],
  ): void => {
    const all = getChildren(state, parentId);
    const children = onlyLinked && parentId === null
      ? all.filter((node) => isLinked(state, node.id))
      : all;
    // The roots are a list, not a split. Most exchanges in a chat are tied
    // to nothing, so they are all roots, and indenting them all would push
    // every row one column right for no reason. An indent means one thing:
    // this exchange hangs under the one above it.
    const splits = parentId !== null && children.length > 1;

    children.forEach((node, index) => {
      if (visited.has(node.id)) return;
      visited.add(node.id);

      const isLast = index === children.length - 1;
      // Move right only where the conversation really splits.
      const myIndent = splits ? indent + 1 : indent;
      const myGuides = splits ? [...guides, !isLast] : guides;
      const grandChildren = getChildren(state, node.id);

      rows.push({
        node,
        depth,
        indent: myIndent,
        childCount: grandChildren.length,
        isLastSibling: isLast,
        isBranch: splits,
        guides: myGuides,
      });

      walk(node.id, depth + 1, myIndent, myGuides);
    });
  };

  walk(null, 0, 0, []);
  return rows;
}

/** Every node in the subtree of `id`, including `id` itself. */
export function subtreeIds(state: TreeState, id: string): string[] {
  if (state.nodes[id] === undefined) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [id];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    result.push(current);
    for (const child of getChildren(state, current)) stack.push(child.id);
  }
  return result;
}

// --------------------------------------------------------------- mutation

function withNodes(
  state: TreeState,
  nodes: Record<string, TreeNode>,
  pendingParentId: string | null,
  now: number,
): TreeState {
  return {
    version: TREE_VERSION,
    conversationId: state.conversationId,
    nodes,
    pendingParentId,
    updatedAt: now,
  };
}

/** Add a node under an explicit parent. Pass `null` to make it a root. */
export function addNode(
  state: TreeState,
  input: NewNode,
  parentId: string | null,
  now: number,
): Result<TreeState> {
  if (input.id === '') return err('BAD_PAYLOAD', 'the node id must not be empty');
  if (state.nodes[input.id] !== undefined) {
    return err('DUPLICATE_NODE', `node ${input.id} is already in the tree`);
  }
  if (parentId === input.id) {
    return err('SELF_PARENT', 'a node must not be its own parent');
  }
  if (parentId !== null && state.nodes[parentId] === undefined) {
    return err('PARENT_NOT_FOUND', `parent ${parentId} is not in the tree`);
  }

  const node: TreeNode = {
    id: input.id,
    parentId,
    position: input.position ?? null,
    label: input.label,
    createdAt: input.createdAt ?? now,
    order: nextOrder(state, parentId),
  };
  const nodes = { ...state.nodes, [node.id]: node };
  // The choice is spent. The next question goes back to the default parent.
  return ok(withNodes(state, nodes, null, now));
}

/**
 * Add a node under the parent the user chose in the tree panel.
 * It falls back to the newest node, and then to the root.
 * It clears the pending choice.
 */
export function addNodeUsingPendingParent(
  state: TreeState,
  input: NewNode,
  now: number,
): Result<TreeState> {
  const parentId = effectiveParentId(state);
  // `effectiveParentId` can only name a node that exists, so this is safe.
  return addNode(state, input, parentId === input.id ? null : parentId, now);
}

export function setPendingParent(
  state: TreeState,
  parentId: string | null,
  now: number,
): Result<TreeState> {
  if (parentId !== null && state.nodes[parentId] === undefined) {
    return err('NODE_NOT_FOUND', `node ${parentId} is not in the tree`);
  }
  return ok(withNodes(state, { ...state.nodes }, parentId, now));
}

/**
 * Record where claude.ai last drew this exchange.
 * It sorts the list. It never decides a link.
 */
export function setPosition(
  state: TreeState,
  id: string,
  position: number | null,
  now: number,
): Result<TreeState> {
  const node = state.nodes[id];
  if (node === undefined) return err('NODE_NOT_FOUND', `node ${id} is not in the tree`);
  if (node.position === position) return ok(state);
  const nodes = { ...state.nodes, [id]: { ...node, position } };
  return ok(withNodes(state, nodes, state.pendingParentId, now));
}

export function setLabel(
  state: TreeState,
  id: string,
  label: string,
  now: number,
): Result<TreeState> {
  const node = state.nodes[id];
  if (node === undefined) return err('NODE_NOT_FOUND', `node ${id} is not in the tree`);
  const nodes = { ...state.nodes, [id]: { ...node, label } };
  return ok(withNodes(state, nodes, state.pendingParentId, now));
}

/** Move a node, and its whole subtree, under a new parent. */
export function setParent(
  state: TreeState,
  id: string,
  parentId: string | null,
  now: number,
): Result<TreeState> {
  const node = state.nodes[id];
  if (node === undefined) return err('NODE_NOT_FOUND', `node ${id} is not in the tree`);
  if (parentId === id) return err('SELF_PARENT', 'a node must not be its own parent');
  if (parentId !== null && state.nodes[parentId] === undefined) {
    return err('PARENT_NOT_FOUND', `parent ${parentId} is not in the tree`);
  }
  if (parentId !== null && isDescendantOf(state, parentId, id)) {
    return err('WOULD_CREATE_CYCLE', `node ${parentId} is already below node ${id}`);
  }
  if (node.parentId === parentId) return ok(state);

  const moved: TreeNode = { ...node, parentId, order: nextOrder(state, parentId) };
  const nodes = { ...state.nodes, [id]: moved };
  return ok(withNodes(state, nodes, state.pendingParentId, now));
}

export interface RemoveOptions {
  /** True removes the whole subtree. False lifts the children to the grandparent. */
  readonly cascade: boolean;
}

export function removeNode(
  state: TreeState,
  id: string,
  options: RemoveOptions,
  now: number,
): Result<TreeState> {
  const node = state.nodes[id];
  if (node === undefined) return err('NODE_NOT_FOUND', `node ${id} is not in the tree`);

  const nodes: Record<string, TreeNode> = { ...state.nodes };

  if (options.cascade) {
    for (const doomed of subtreeIds(state, id)) delete nodes[doomed];
  } else {
    for (const child of getChildren(state, id)) {
      const existing = nodes[child.id];
      if (existing !== undefined) nodes[child.id] = { ...existing, parentId: node.parentId };
    }
    delete nodes[id];
  }

  const pending = state.pendingParentId;
  const stillThere = pending !== null && nodes[pending] !== undefined;
  return ok(withNodes(state, nodes, stillThere ? pending : null, now));
}

// ------------------------------------------------------------------ repair

export interface RepairReport {
  readonly state: TreeState;
  /** One line per change. It is empty when the state was already sound. */
  readonly fixes: readonly string[];
}

/**
 * Make a state sound again.
 * It cuts a parent link that points at a missing node, and it breaks cycles.
 * Storage can hold an old or a half written state, so run this after a load.
 */
export function repair(state: TreeState, now: number): RepairReport {
  const nodes: Record<string, TreeNode> = {};
  const fixes: string[] = [];

  for (const [id, node] of Object.entries(state.nodes)) {
    if (id !== node.id) {
      fixes.push(`key ${id} did not match node id ${node.id}; used the node id`);
    }
    nodes[node.id] = node;
  }

  // Cut a link to a parent that is gone.
  for (const node of Object.values(nodes)) {
    const parentId = node.parentId;
    if (parentId !== null && nodes[parentId] === undefined) {
      nodes[node.id] = { ...node, parentId: null };
      fixes.push(`node ${node.id} lost its parent ${parentId}; it is now a root`);
    }
  }

  // Break every cycle. Walk up from each node and watch for a repeat.
  for (const start of Object.keys(nodes)) {
    const seen = new Set<string>();
    let current = nodes[start];
    while (current !== undefined) {
      if (seen.has(current.id)) {
        nodes[current.id] = { ...current, parentId: null };
        fixes.push(`node ${current.id} sat in a cycle; it is now a root`);
        break;
      }
      seen.add(current.id);
      const parentId = current.parentId;
      current = parentId === null ? undefined : nodes[parentId];
    }
  }

  let pending = state.pendingParentId;
  if (pending !== null && nodes[pending] === undefined) {
    fixes.push(`the pending parent ${pending} is gone; the choice is cleared`);
    pending = null;
  }

  if (fixes.length === 0) return { state, fixes };
  return { state: withNodes(state, nodes, pending, now), fixes };
}

// ----------------------------------------------------------- persistence

export function serialize(state: TreeState): string {
  return JSON.stringify(state);
}

/** Read a stored tree. It repairs the state and reports what it changed. */
export function deserialize(raw: string, now: number): Result<RepairReport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err('BAD_PAYLOAD', 'the stored tree is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return err('BAD_PAYLOAD', 'the stored tree is not an object');
  }
  const candidate = parsed as Partial<TreeState>;
  if (candidate.version !== TREE_VERSION) {
    return err('BAD_VERSION', `expected version ${TREE_VERSION}, found ${String(candidate.version)}`);
  }
  if (typeof candidate.conversationId !== 'string' || candidate.conversationId === '') {
    return err('BAD_PAYLOAD', 'the stored tree has no conversation id');
  }
  if (typeof candidate.nodes !== 'object' || candidate.nodes === null) {
    return err('BAD_PAYLOAD', 'the stored tree has no node map');
  }

  const nodes: Record<string, TreeNode> = {};
  for (const [key, value] of Object.entries(candidate.nodes)) {
    if (typeof value !== 'object' || value === null) continue;
    const n = value as Partial<TreeNode>;
    if (typeof n.id !== 'string' || n.id === '') continue;
    const stored = typeof n.parentId === 'string' ? n.parentId : null;
    // An older tree marked each link as yours or as a guess. The extension
    // no longer guesses, so a guessed link means nothing now: drop it and
    // let the node stand on its own. A link you made is kept.
    const guessed = (n as { parentSource?: string }).parentSource === 'auto';
    const parentId = guessed ? null : stored;
    const legacyPosition = (n as { transcriptIndex?: unknown }).transcriptIndex;
    nodes[n.id] = {
      id: n.id,
      parentId,
      position: typeof n.position === 'number'
        ? n.position
        : (typeof legacyPosition === 'number' ? legacyPosition : null),
      label: typeof n.label === 'string' ? n.label : '(no label)',
      createdAt: typeof n.createdAt === 'number' ? n.createdAt : now,
      order: typeof n.order === 'number' ? n.order : 0,
    };
    void key;
  }

  const loaded: TreeState = {
    version: TREE_VERSION,
    conversationId: candidate.conversationId,
    nodes,
    pendingParentId: typeof candidate.pendingParentId === 'string' ? candidate.pendingParentId : null,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : now,
  };

  return ok(repair(loaded, now));
}
