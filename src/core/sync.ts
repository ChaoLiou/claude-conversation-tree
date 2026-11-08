/**
 * Keep the stored tree in step with what the page shows.
 *
 * This module is pure. It takes the exchanges the adapter read and the tree
 * that storage held, and it returns the next tree.
 *
 * It does nothing at all with links. A new exchange stands on its own. You
 * give it a parent in the panel, after you read the reply.
 *
 * That rule is the whole design. An earlier version read the order of the
 * rows and guessed which exchange followed which. Every fault in this
 * project came from that guess, because claude.ai draws only part of a
 * long conversation, drops the rows in the middle, renumbers every row
 * when it loads older messages, and can be read while it is halfway
 * through a change. A guess made from such a page is wrong often enough
 * to move links about on their own. So the extension no longer guesses.
 *
 * What it still does:
 *
 *   1. List every exchange it sees, so you can tie any of them up later.
 *      An exchange with no link is a tree of one node.
 *   2. Fill in a label that the page had not rendered yet.
 *   3. Record where the page last drew each exchange, to sort the list.
 *      That number sorts, and does nothing else.
 */

import {
  addNode,
  deriveLabel,
  getNode,
  setLabel,
  setPosition,
  type TreeState,
} from './tree.js';

/** The part of an exchange that the tree needs. */
export interface SyncInput {
  readonly turnId: string;
  /** The question text. An empty string means the page has not shown it yet. */
  readonly questionText: string;
  /** Where the page drew it. For sorting only. */
  readonly index?: number | null;
}

export interface SyncResult {
  readonly state: TreeState;
  /** The ids this call added, in the order it added them. */
  readonly added: readonly string[];
  /** The ids whose label this call filled in. */
  readonly relabelled: readonly string[];
  /** One line per rule that could not run. It is empty in the normal case. */
  readonly problems: readonly string[];
}

const EMPTY_LABEL = '(no question yet)';

/** The label the tree shows while the page has not rendered the question. */
export const PLACEHOLDER_LABEL = EMPTY_LABEL;

/**
 * Fold the page's exchanges into the tree.
 * Call it after every change to the message list. It is safe to repeat.
 */
export function syncWithTranscript(
  state: TreeState,
  exchanges: readonly SyncInput[],
  now: number,
): SyncResult {
  let next = state;
  const added: string[] = [];
  const relabelled: string[] = [];
  const problems: string[] = [];

  for (const exchange of exchanges) {
    const position = exchange.index ?? null;
    const existing = getNode(next, exchange.turnId);

    if (existing !== null) {
      // Fill in a label that the page had not rendered yet.
      const better = exchange.questionText === '' ? '' : deriveLabel(exchange.questionText);
      if (better !== '' && (existing.label === EMPTY_LABEL || existing.label === '')) {
        const result = setLabel(next, exchange.turnId, better, now);
        if (result.ok) {
          next = result.value;
          relabelled.push(exchange.turnId);
        } else {
          problems.push(`could not relabel ${exchange.turnId}: ${result.error.code}`);
        }
      }

      // Keep the sorting number fresh. It never changes a link.
      if (position !== null && existing.position !== position) {
        const result = setPosition(next, exchange.turnId, position, now);
        if (result.ok) next = result.value;
      }
      continue;
    }

    // A new exchange always stands on its own. Only the user makes a link.
    const parentId: string | null = null;

    const label = exchange.questionText === '' ? EMPTY_LABEL : deriveLabel(exchange.questionText);
    const result = addNode(next, { id: exchange.turnId, label, position }, parentId, now);
    if (result.ok) {
      next = result.value;
      added.push(exchange.turnId);
    } else {
      problems.push(`could not add ${exchange.turnId}: ${result.error.code}`);
    }
  }

  return { state: next, added, relabelled, problems };
}
