/**
 * The only module that knows what claude.ai's page looks like.
 *
 * Every selector in this file came from tools/probe-run.mjs, not from a
 * guess. When claude.ai changes its markup, this file is the only one to
 * repair. The tree model and the panel never touch the page.
 *
 * What the probe found, on 2026-11-06:
 *
 *   [role="feed"][data-perf-region="transcript"]      the message list
 *   └ [data-testid="transcript-sizer"]
 *     └ [data-testid="transcript-row"]                one per message
 *         data-perf-row="human" | "assistant"         the role
 *         data-index="0".."N"                         the position
 *       └ ... [data-turn-key]                         a stable id
 *
 * A turn key is `<uuid>` on a question and `<uuid>-hub-reply` on its reply,
 * so one uuid names one exchange. The id survives a page reload, which is
 * why the tree can store it.
 */

export const SELECTORS = {
  /** The list that holds every message. */
  feed: '[role="feed"][data-perf-region="transcript"]',
  /** The element that scrolls. The panel scrolls this, not the window. */
  scrollContainer: '[data-autoscroll-container="true"]',
  /** One per message, for both roles. */
  row: '[data-testid="transcript-row"]',
  /**
   * The element that says which conversation the message list belongs to.
   *
   * This matters. When you move to another conversation, claude.ai changes
   * the address first and the message list about 400 ms later. A reader
   * that trusts the address therefore files the old conversation's
   * exchanges under the new conversation. This attribute does not move
   * early, so it is the one to trust.
   */
  conversationScope: '[data-conv-id]',
  /** The part of a row that carries the position and the total. */
  article: '[role="article"]',
  /** The column that holds the list and the message box. */
  chatColumn: '[data-testid="chat-column"]',
  /** The box you type into. */
  composer: 'div[contenteditable="true"], textarea',
  /**
   * The message body inside a row.
   *
   * A row also holds a heading for a screen reader. That heading repeats the
   * message and puts a spoken prefix in front of it, such as "You said:".
   * Reading the row itself would therefore give the text twice.
   */
  messageBody: '[data-user-scope], [data-reply-scope]',
  /**
   * Parts of a message that are not the message.
   *
   * A row carries a heading for a screen reader, a row of action buttons,
   * a tooltip for those buttons, and icon glyphs. All of that sits inside
   * the message body, so a plain text read picks it up.
   */
  notText: [
    '[data-find-omitted]',
    '[aria-hidden="true"]',
    '[data-deferred]',
    '[role="status"]',
    '[role="tooltip"]',
    '[data-cds="MessageActions"]',
    '[data-testid$="-message-actions"]',
    '[data-cds-tooltip]',
    '[data-cds-tooltip-pending]',
    'button',
    '[role="button"]',
    'svg',
  ].join(', '),
} as const;

/** Characters that an icon font draws. They are not readable text. */
const ICON_GLYPHS = /[\uE000-\uF8FF\uFFF0-\uFFFF]/g;

/** Elements that start a new line, so the text needs a gap after them. */
const BLOCK_TAGS = 'div, p, br, li, h1, h2, h3, h4, h5, h6, pre, blockquote, tr';

/** A reply's turn key is its question's turn key plus this suffix. */
export const REPLY_SUFFIX = '-hub-reply';

/** The attribute that carries the stable id. */
export const TURN_KEY_ATTR = 'data-turn-key';

export type TurnRole = 'human' | 'assistant' | 'unknown';

export interface TranscriptRow {
  readonly element: HTMLElement;
  /** The bare uuid, with no role suffix. `null` when the page gave none. */
  readonly turnId: string | null;
  readonly role: TurnRole;
  /** The position claude.ai gave the row, or `null`. */
  readonly index: number | null;
  readonly streaming: boolean;
}

/** One exchange: a question and the reply to it. Either part may be absent. */
export interface Exchange {
  readonly turnId: string;
  readonly question: TranscriptRow | null;
  readonly reply: TranscriptRow | null;
  /**
   * Where the page drew this exchange.
   *
   * It sorts the list, and it does nothing else. The number counts inside
   * the piece of the conversation that claude.ai has loaded, not inside
   * the whole conversation, and every one of them moves when older
   * messages arrive. No link is ever read from it.
   */
  readonly index: number | null;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ------------------------------------------------------------------ page

/** The conversation uuid in the address bar, or `null` on another page. */
export function conversationIdFromUrl(href: string = location.href): string | null {
  const match = href.match(/\/chat\/([0-9a-f-]{36})/i);
  return match?.[1] ?? null;
}

export function isConversationPage(href: string = location.href): boolean {
  return conversationIdFromUrl(href) !== null;
}

export function findFeed(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(SELECTORS.feed);
}

export function findScrollContainer(root: ParentNode = document): HTMLElement | null {
  const marked = root.querySelector<HTMLElement>(SELECTORS.scrollContainer);
  if (marked !== null) return marked;
  // Fall back to the nearest ancestor of the list that really scrolls.
  const feed = findFeed(root);
  let el: HTMLElement | null = feed?.parentElement ?? null;
  while (el !== null) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
    el = el.parentElement;
  }
  return null;
}

export function findComposer(root: ParentNode = document): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(SELECTORS.composer)) {
    const box = el.getBoundingClientRect();
    if (box.width > 120 && box.height > 16) return el;
  }
  return null;
}

// --------------------------------------------------------------- reading

/** Strip the role suffix, so a question and its reply give the same id. */
export function normaliseTurnKey(rawKey: string | null): string | null {
  if (rawKey === null || rawKey === '') return null;
  const bare = rawKey.endsWith(REPLY_SUFFIX)
    ? rawKey.slice(0, -REPLY_SUFFIX.length)
    : rawKey;
  return UUID_RE.test(bare) ? bare : null;
}

function rawTurnKeyOf(row: HTMLElement): string | null {
  if (row.hasAttribute(TURN_KEY_ATTR)) return row.getAttribute(TURN_KEY_ATTR);
  const inside = row.querySelector<HTMLElement>(`[${TURN_KEY_ATTR}]`);
  if (inside !== null) return inside.getAttribute(TURN_KEY_ATTR);
  const above = row.closest<HTMLElement>(`[${TURN_KEY_ATTR}]`);
  return above?.getAttribute(TURN_KEY_ATTR) ?? null;
}

function roleOf(row: HTMLElement): TurnRole {
  const value = row.getAttribute('data-perf-row');
  if (value === 'human' || value === 'assistant') return value;
  return 'unknown';
}

function describeRow(element: HTMLElement): TranscriptRow {
  const rawIndex = element.getAttribute('data-index');
  const parsed = rawIndex === null ? Number.NaN : Number.parseInt(rawIndex, 10);
  return {
    element,
    turnId: normaliseTurnKey(rawTurnKeyOf(element)),
    role: roleOf(element),
    index: Number.isNaN(parsed) ? null : parsed,
    streaming: element.getAttribute('data-perf-row-streaming') === 'true',
  };
}

/**
 * Every message row the page holds right now.
 *
 * claude.ai may drop a row that scrolled far out of sight, so this list can
 * be shorter than the conversation. The stored tree keeps the nodes it has
 * already seen, so a missing row loses no part of the tree.
 */
export function readTranscript(root: ParentNode = document): TranscriptRow[] {
  const rows = root.querySelectorAll<HTMLElement>(SELECTORS.row);
  return Array.from(rows, describeRow);
}

/** Group the rows into exchanges, in page order. */
export function readExchanges(root: ParentNode = document): Exchange[] {
  const order: string[] = [];
  const byId = new Map<string, { question: TranscriptRow | null; reply: TranscriptRow | null }>();

  for (const row of readTranscript(root)) {
    const id = row.turnId;
    if (id === null) continue;
    let entry = byId.get(id);
    if (entry === undefined) {
      entry = { question: null, reply: null };
      byId.set(id, entry);
      order.push(id);
    }
    if (row.role === 'assistant') entry.reply = row;
    else entry.question = row;
  }

  return order.map((turnId) => {
    const entry = byId.get(turnId);
    const question = entry?.question ?? null;
    const reply = entry?.reply ?? null;
    const positions: number[] = [];
    if (question?.index != null) positions.push(question.index);
    if (reply?.index != null) positions.push(reply.index);
    return {
      turnId,
      question,
      reply,
      index: positions.length === 0 ? null : Math.min(...positions),
    };
  });
}

function collapse(text: string): string {
  return text.replace(ICON_GLYPHS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The text of a message, with everything that is not the message removed.
 *
 * It works on a copy, so the page is never changed. It takes the message
 * body when the row has one, and the whole row when it does not, so a
 * change in claude.ai gives a poorer label instead of no label.
 */
export function textOfRow(row: TranscriptRow): string {
  const source = row.element.querySelector<HTMLElement>(SELECTORS.messageBody)
    ?? row.element;
  const copy = source.cloneNode(true) as HTMLElement;

  for (const unwanted of copy.querySelectorAll(SELECTORS.notText)) unwanted.remove();

  // A copy has no layout, so `innerText` is empty. `textContent` runs the
  // blocks together, so put a gap after each one.
  for (const block of copy.querySelectorAll(BLOCK_TAGS)) {
    block.appendChild(copy.ownerDocument.createTextNode(' '));
  }

  return collapse(copy.textContent ?? '');
}

/** The question text of an exchange. The tree uses it as the node label. */
export function questionTextOf(exchange: Exchange): string {
  return exchange.question === null ? '' : textOfRow(exchange.question);
}

export function findRowByTurnId(
  turnId: string,
  role: TurnRole = 'human',
  root: ParentNode = document,
): TranscriptRow | null {
  for (const row of readTranscript(root)) {
    if (row.turnId === turnId && row.role === role) return row;
  }
  for (const row of readTranscript(root)) {
    if (row.turnId === turnId) return row;
  }
  return null;
}

/**
 * Which conversation does the message list on the page belong to?
 *
 * Read this before you store anything. The address bar changes before the
 * list does, so the address alone will put one conversation's exchanges
 * into another conversation's tree.
 */
export function conversationIdOfTranscript(root: ParentNode = document): string | null {
  const feed = findFeed(root);
  const scope = feed?.closest<HTMLElement>(SELECTORS.conversationScope)
    ?? root.querySelector<HTMLElement>(SELECTORS.conversationScope);
  const value = scope?.getAttribute('data-conv-id') ?? null;
  return value === '' ? null : value;
}

/**
 * How many messages claude.ai currently holds for this conversation.
 *
 * This is NOT the length of the conversation. claude.ai loads the history
 * a piece at a time: scrolling back fetches older messages, this number
 * grows, and every `data-index` moves with it. Treat it as "how much is
 * loaded right now", and never as a total.
 */
export function loadedMessageCount(root: ParentNode = document): number | null {
  const article = root.querySelector<HTMLElement>(
    `${SELECTORS.row} ${SELECTORS.article}[aria-setsize]`,
  );
  const raw = article?.getAttribute('aria-setsize') ?? null;
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? null : value;
}

export interface IndexRange {
  readonly min: number;
  readonly max: number;
  readonly count: number;
}

/**
 * The span of rows that the page has drawn.
 *
 * The drawn rows are not always one unbroken run. claude.ai keeps the rows
 * at each end of a long conversation and drops the ones in the middle, so
 * the set can look like 0..7 and then 29..31. Two rows that sit next to
 * each other in the page are therefore not always next to each other in
 * the conversation. Check the numbers before you believe the order.
 */
export function renderedIndexRange(root: ParentNode = document): IndexRange | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const row of readTranscript(root)) {
    if (row.index === null) continue;
    count++;
    if (row.index < min) min = row.index;
    if (row.index > max) max = row.index;
  }
  if (count === 0) return null;
  return { min, max, count };
}

// ------------------------------------------------------------- scrolling

export interface ScrollResult {
  readonly found: boolean;
  /** How many times the view moved while it looked for the row. */
  readonly attempts: number;
  /** How far the row ended from the middle, in pixels. */
  readonly offCentreBy: number | null;
  /** Why it gave up. `null` when it found the row and settled on it. */
  readonly gaveUpBecause:
    | 'no-scroll-container'
    | 'reached-the-end'
    | 'ran-out-of-attempts'
    | 'took-too-long'
    | 'never-settled'
    | 'cancelled'
    | null;
}

export type ScrollDirection = 'up' | 'down';

export interface ScrollOptions {
  /**
   * Which way the exchange lies. The caller knows, because the tree knows
   * the order of the exchanges. The page does not: its row numbers move
   * every time older messages load.
   */
  readonly direction?: ScrollDirection;
  /** How many times to move the view and look again. */
  readonly attempts?: number;
  /**
   * The longest the whole search may take, in ms.
   *
   * An exchange can be in the tree and not in the conversation any more:
   * claude.ai gives a message a new id when you edit or retry it, and the
   * old one stops being drawn. Without a deadline the search keeps asking
   * the page for a row that will never come back.
   */
  readonly deadlineMs?: number;
  /** How long to let the view settle after the row appears, in ms. */
  readonly settleBudgetMs?: number;
  /** How long to wait for claude.ai to draw more rows, in ms. */
  readonly waitMs?: number;
  /** How close to the middle counts as done, in pixels. */
  readonly tolerancePx?: number;
  /**
   * Cancel this move.
   *
   * A second jump must cancel the first one. Otherwise both loops run and
   * each one drags the view back towards its own target.
   */
  readonly signal?: AbortSignal;
  readonly root?: ParentNode;
}

function centreOffsetOf(element: HTMLElement, container: HTMLElement | null): number {
  const box = element.getBoundingClientRect();
  const middle = container === null
    ? window.innerHeight / 2
    : container.getBoundingClientRect().top + container.clientHeight / 2;
  return Math.abs(box.top + box.height / 2 - middle);
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait, but give up at once when the caller cancels.
 *
 * Every move of the view must be cancellable. Two of these loops running
 * together pull the page in two directions, and each pull redraws the
 * message list, which makes the tree read a list that keeps changing.
 */
function waitOrCancel(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return wait(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * Hold an exchange in the middle of the view until the page stops moving.
 *
 * One call to `scrollIntoView` is not enough. Putting an old exchange in
 * view makes claude.ai fetch the messages before it, which makes the page
 * taller and pushes the exchange away again. So this re-aims until the
 * offset is small and the number of drawn rows has stopped changing.
 */
async function settleOn(
  turnId: string,
  root: ParentNode,
  budgetMs: number,
  tolerancePx: number,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<{ settled: boolean; cancelled: boolean; offCentreBy: number | null }> {
  const deadline = Date.now() + budgetMs;
  let offCentre: number | null = null;
  let lastRowCount = -1;
  let quietRounds = 0;

  while (Date.now() < deadline) {
    if (isCancelled(signal)) return { settled: false, cancelled: true, offCentreBy: offCentre };

    const row = findRowByTurnId(turnId, 'human', root);
    if (row === null) return { settled: false, cancelled: false, offCentreBy: offCentre };

    row.element.scrollIntoView({ block: 'center', behavior: 'auto' });
    await waitOrCancel(waitMs, signal);
    if (isCancelled(signal)) return { settled: false, cancelled: true, offCentreBy: offCentre };

    const after = findRowByTurnId(turnId, 'human', root) ?? row;
    offCentre = centreOffsetOf(after.element, findScrollContainer(root));
    const rowCount = readTranscript(root).length;

    const stillThere = offCentre <= tolerancePx;
    const pageQuiet = rowCount === lastRowCount;
    lastRowCount = rowCount;

    if (stillThere && pageQuiet) {
      quietRounds++;
      // Two quiet rounds in a row means claude.ai has stopped fetching.
      if (quietRounds >= 2) return { settled: true, cancelled: false, offCentreBy: offCentre };
    } else {
      quietRounds = 0;
    }
  }
  return { settled: false, cancelled: false, offCentreBy: offCentre };
}

/**
 * Bring an exchange into view.
 *
 * Two things make this harder than one call to `scrollIntoView`:
 *
 *   1. claude.ai draws only part of a long conversation. An older exchange
 *      is simply not on the page until you scroll back to it.
 *   2. Every batch of older messages makes the page taller and moves the
 *      exchange you aimed at.
 */
/** True when the view cannot move any further that way. */
function atEnd(container: HTMLElement, direction: ScrollDirection): boolean {
  if (direction === 'up') return container.scrollTop <= 1;
  return container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
}

export async function scrollToTurn(
  turnId: string,
  options: ScrollOptions = {},
): Promise<ScrollResult> {
  const attempts = options.attempts ?? 40;
  const waitMs = options.waitMs ?? 260;
  const tolerancePx = options.tolerancePx ?? 120;
  const settleBudgetMs = options.settleBudgetMs ?? 12000;
  const deadline = Date.now() + (options.deadlineMs ?? 30000);
  const root = options.root ?? document;
  const signal = options.signal;
  const first: ScrollDirection = options.direction ?? 'up';

  // Look the way the caller expects first, then the other way. The caller
  // works the direction out from the tree, and the tree's idea of the
  // order can be out of date, so a one way search would give up with the
  // row sitting just off the other end.
  const directions: ScrollDirection[] = first === 'up' ? ['up', 'down'] : ['down', 'up'];

  let spent = 0;
  const cancelled = (): ScrollResult => ({
    found: false, attempts: spent, offCentreBy: null, gaveUpBecause: 'cancelled',
  });

  for (const direction of directions) {
    while (spent <= attempts) {
      if (isCancelled(signal)) return cancelled();
      if (Date.now() > deadline) {
        return {
          found: false, attempts: spent, offCentreBy: null,
          gaveUpBecause: 'took-too-long',
        };
      }

      if (findRowByTurnId(turnId, 'human', root) !== null) {
        const result = await settleOn(turnId, root, settleBudgetMs, tolerancePx, waitMs, signal);
        if (result.cancelled) return cancelled();
        return {
          found: true,
          attempts: spent,
          offCentreBy: result.offCentreBy,
          gaveUpBecause: result.settled ? null : 'never-settled',
        };
      }

      const container = findScrollContainer(root);
      if (container === null) {
        return {
          found: false, attempts: spent, offCentreBy: null,
          gaveUpBecause: 'no-scroll-container',
        };
      }

      spent++;

      if (atEnd(container, direction)) {
        // This end is reached. claude.ai may still be fetching, so wait
        // once and see whether the page grew. If it did not, this
        // direction is finished: try the other one.
        const heightBefore = container.scrollHeight;
        const rowsBefore = readTranscript(root).length;
        await waitOrCancel(waitMs * 4, signal);
        if (isCancelled(signal)) return cancelled();
        const grew = container.scrollHeight > heightBefore
          || readTranscript(root).length !== rowsBefore;
        if (!grew) break;
        continue;
      }

      const step = Math.max(400, container.clientHeight - 80);
      container.scrollTop = direction === 'up'
        ? Math.max(0, container.scrollTop - step)
        : Math.min(container.scrollHeight, container.scrollTop + step);
      await waitOrCancel(waitMs, signal);
    }
    if (spent > attempts || Date.now() > deadline) break;
  }

  // One last look, in case the row arrived while the search turned round.
  if (findRowByTurnId(turnId, 'human', root) !== null) {
    const result = await settleOn(turnId, root, settleBudgetMs, tolerancePx, waitMs, signal);
    if (result.cancelled) return cancelled();
    return {
      found: true,
      attempts: spent,
      offCentreBy: result.offCentreBy,
      gaveUpBecause: result.settled ? null : 'never-settled',
    };
  }

  if (Date.now() > deadline) {
    return { found: false, attempts: spent, offCentreBy: null, gaveUpBecause: 'took-too-long' };
  }
  return {
    found: false,
    attempts: spent,
    offCentreBy: null,
    gaveUpBecause: spent > attempts ? 'ran-out-of-attempts' : 'reached-the-end',
  };
}

export interface SweepProgress {
  readonly phase: 'up' | 'down';
  /** How many messages claude.ai holds now. */
  readonly loaded: number;
  /** How far down the view is, from 0 to 1. */
  readonly position: number;
}

export interface SweepResult {
  /** True when a later action cancelled this one. */
  readonly cancelled: boolean;
  readonly loaded: number | null;
  /** True when the climb reached the start of the conversation. */
  readonly reachedTheStart: boolean;
  /** True when the sweep went from the start back to the end. */
  readonly sawEveryPair: boolean;
  readonly rounds: number;
}

/**
 * Read the whole conversation, so the tree can hold all of it.
 *
 * Two passes, and both are needed:
 *
 *   up    Climb one screen at a time. claude.ai fetches older messages as
 *         you go, so this is what brings the history in. A jump straight
 *         to the top fetches the same messages but draws almost none of
 *         them, which teaches the tree nothing.
 *
 *   down  Walk back to the end, one screen at a time. claude.ai keeps the
 *         rows at each end of a long conversation and drops the middle, so
 *         standing at the top is not enough: the pairs in the middle have
 *         still never been on the page together. The tree learns which
 *         exchange follows which only while this pass moves over them.
 *
 * It calls `onProgress` after every step, and the caller re-reads the page
 * there. That call is the whole point of the sweep.
 */
export async function sweepConversation(
  options: {
    readonly onProgress?: (progress: SweepProgress) => void;
    readonly maxRounds?: number;
    readonly waitMs?: number;
    readonly signal?: AbortSignal;
    readonly root?: ParentNode;
  } = {},
): Promise<SweepResult> {
  const maxRounds = options.maxRounds ?? 400;
  const waitMs = options.waitMs ?? 420;
  const root = options.root ?? document;
  const signal = options.signal;

  const container = findScrollContainer(root);
  if (container === null) {
    return {
      cancelled: isCancelled(signal),
      loaded: loadedMessageCount(root),
      reachedTheStart: false,
      sawEveryPair: false,
      rounds: 0,
    };
  }

  const stepSize = (): number => Math.max(300, container.clientHeight - 120);
  const report = (phase: 'up' | 'down'): void => {
    const span = Math.max(1, container.scrollHeight - container.clientHeight);
    options.onProgress?.({
      phase,
      loaded: loadedMessageCount(root) ?? 0,
      position: Math.min(1, Math.max(0, container.scrollTop / span)),
    });
  };

  let rounds = 0;
  let lastLoaded = -1;
  let quiet = 0;
  let reachedTheStart = false;

  // Pass one: climb, and let claude.ai fetch the history.
  while (rounds < maxRounds) {
    if (isCancelled(signal)) {
      return { cancelled: true, loaded: loadedMessageCount(root), reachedTheStart, sawEveryPair: false, rounds };
    }
    rounds++;
    container.scrollTop = Math.max(0, container.scrollTop - stepSize());
    await waitOrCancel(waitMs, signal);
    if (isCancelled(signal)) {
      return { cancelled: true, loaded: loadedMessageCount(root), reachedTheStart, sawEveryPair: false, rounds };
    }
    report('up');

    const loaded = loadedMessageCount(root) ?? 0;
    const atTop = container.scrollTop <= 2;
    if (loaded === lastLoaded && atTop) {
      quiet++;
      if (quiet >= 3) { reachedTheStart = true; break; }
    } else {
      quiet = 0;
      lastLoaded = loaded;
    }
  }

  // Pass two: walk back down, so every neighbouring pair is drawn together.
  let sawEveryPair = false;
  while (rounds < maxRounds) {
    if (isCancelled(signal)) {
      return { cancelled: true, loaded: loadedMessageCount(root), reachedTheStart, sawEveryPair, rounds };
    }
    rounds++;
    const before = container.scrollTop;
    container.scrollTop = Math.min(container.scrollHeight, before + stepSize());
    await waitOrCancel(waitMs, signal);
    if (isCancelled(signal)) {
      return { cancelled: true, loaded: loadedMessageCount(root), reachedTheStart, sawEveryPair, rounds };
    }
    report('down');

    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
    if (atBottom || container.scrollTop === before) { sawEveryPair = true; break; }
  }

  return {
    cancelled: false,
    loaded: loadedMessageCount(root),
    reachedTheStart,
    sawEveryPair,
    rounds,
  };
}

/** Flash a row, so the eye finds it after the scroll. */
export function flashRow(row: TranscriptRow, className: string, ms = 1600): void {
  row.element.classList.add(className);
  setTimeout(() => row.element.classList.remove(className), ms);
}

// -------------------------------------------------------------- watching

/**
 * Call `onChange` when the message list changes.
 * It waits for a quiet moment, so a streaming reply fires it once, not
 * once per word.
 */
export function watchTranscript(
  onChange: () => void,
  options: { readonly quietMs?: number; readonly root?: ParentNode } = {},
): () => void {
  const quietMs = options.quietMs ?? 400;
  const root = options.root ?? document;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const fire = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(onChange, quietMs);
  };

  // Watch the document, not the message list. claude.ai replaces the whole
  // list when you move to another conversation, and an observer attached to
  // the old list then sees nothing ever again.
  const document_ = (root as Document).body ?? (root as unknown as Node);
  const watched: Node = document_;
  const observer = new MutationObserver(fire);
  observer.observe(watched, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [TURN_KEY_ATTR, 'data-index', 'data-perf-row-streaming'],
  });

  return () => {
    observer.disconnect();
    if (timer !== null) clearTimeout(timer);
  };
}

/** Watch for a move to another conversation, in a single page application. */
export function watchLocation(onChange: (href: string) => void): () => void {
  let last = location.href;
  const check = (): void => {
    if (location.href === last) return;
    last = location.href;
    onChange(last);
  };
  const timer = setInterval(check, 500);
  window.addEventListener('popstate', check);
  return () => {
    clearInterval(timer);
    window.removeEventListener('popstate', check);
  };
}

/**
 * The exchange the reader is looking at.
 *
 * It is the row nearest the middle of the scrolling area. The panel marks
 * that row, so the panel and the chat always agree on where you are.
 */
export function visibleTurnId(root: ParentNode = document): string | null {
  const container = findScrollContainer(root);
  const box = container?.getBoundingClientRect() ?? null;
  const centre = box === null
    ? window.innerHeight / 2
    : box.top + box.height / 2;

  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of readTranscript(root)) {
    if (row.turnId === null) continue;
    const rect = row.element.getBoundingClientRect();
    if (rect.height === 0) continue;
    const distance = Math.abs(rect.top + rect.height / 2 - centre);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = row.turnId;
    }
  }
  return best;
}
