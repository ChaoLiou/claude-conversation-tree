/**
 * The content script. It joins the three parts together.
 *
 *   adapter/dom.ts  reads claude.ai's page
 *   core/*          holds the tree, and decides where a new node hangs
 *   ui/panel.ts     draws the tree
 *
 * It writes nothing to the page but one small stylesheet, for the flash
 * that marks an exchange after a jump. It sends no request of its own.
 */

import {
  conversationIdFromUrl,
  conversationIdOfTranscript,
  findRowByTurnId,
  flashRow,
  questionTextOf,
  readExchanges,
  loadedMessageCount,
  sweepConversation,
  readTranscript,
  scrollToTurn,
  type ScrollDirection,
  visibleTurnId,
  watchLocation,
  watchTranscript,
} from './adapter/dom.js';
import {
  TreeStore,
  extensionArea,
  localStorageArea,
  type ExtensionStorageArea,
  type KeyValueArea,
} from './core/store.js';
import { syncWithTranscript, type SyncInput } from './core/sync.js';
import {
  getNode,
  isLinked,
  linearize,
  setParent,
  setPendingParent,
  type TreeState,
} from './core/tree.js';
import { TreePanel, type Coverage, type PanelView } from './ui/panel.js';

const FLASH_CLASS = 'claude-tree-flash';
const LOG_PREFIX = '[claude-tree]';

interface MaybeExtensionGlobal {
  readonly storage?: { readonly local?: ExtensionStorageArea };
}

/** Pick the storage the page can reach. The mock page has no extension API. */
function pickArea(): KeyValueArea {
  const scope = globalThis as unknown as {
    browser?: MaybeExtensionGlobal;
    chrome?: MaybeExtensionGlobal;
  };
  const local = scope.browser?.storage?.local ?? scope.chrome?.storage?.local;
  if (local !== undefined) return extensionArea(local);
  return localStorageArea();
}

/**
 * Wait until the document has a body.
 *
 * The manifest asks for `document_idle`, so a body is normally there. But a
 * dev run injects this bundle at document start, and a body is absent then.
 * Waiting here keeps both paths working.
 */
function whenBodyReady(): Promise<void> {
  if (document.body !== null) return Promise.resolve();
  return new Promise((resolve) => {
    if (document.readyState !== 'loading') {
      // The body can still be absent for a moment. Watch for it.
      const observer = new MutationObserver(() => {
        if (document.body === null) return;
        observer.disconnect();
        resolve();
      });
      observer.observe(document.documentElement, { childList: true });
      return;
    }
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

/** One stylesheet in the page, for the flash only. */
function installFlashStyle(): void {
  const parent = document.head ?? document.documentElement;
  if (parent === null) return;
  if (document.getElementById('claude-tree-flash-style') !== null) return;
  const style = document.createElement('style');
  style.id = 'claude-tree-flash-style';
  style.textContent = `
.${FLASH_CLASS} {
  animation: claude-tree-flash 1.6s ease-out 1;
  border-radius: 10px;
}
@keyframes claude-tree-flash {
  0%   { background-color: rgba(194, 92, 58, 0.26); }
  100% { background-color: transparent; }
}`;
  parent.appendChild(style);
}

class Session {
  readonly conversationId: string;
  readonly #store: TreeStore;
  readonly #panel: TreePanel;
  #state: TreeState;
  #notice: string | null;
  #stopWatching: (() => void) | null = null;
  #closed = false;
  /** True while the page shows another conversation's messages. */
  #stale = false;
  /** True until a sweep has shown that no older message is left. */
  #moreMayExist = true;
  #sweeping = false;
  /**
   * The move of the view that is running now.
   *
   * Only one may run. A second jump must cancel the first, or both loops
   * drag the page towards their own target, the message list is redrawn
   * over and over, and the tree reads a list that never settles.
   */
  #move: AbortController | null = null;
  /** True while this extension is moving the view fast, for a jump. */
  #jumping = false;
  /** The exchange waiting for a parent, while a link is open. */
  #linkingChildId: string | null = null;
  /** True while the panel hides the exchanges that stand alone. */
  #onlyLinked = false;

  private constructor(
    conversationId: string,
    store: TreeStore,
    panel: TreePanel,
    state: TreeState,
    notice: string | null,
  ) {
    this.conversationId = conversationId;
    this.#store = store;
    this.#panel = panel;
    this.#state = state;
    this.#notice = notice;
  }

  static async open(conversationId: string, store: TreeStore, panel: TreePanel): Promise<Session> {
    const loaded = await store.load(conversationId, Date.now());
    const notice = loaded.fixes.length === 0 ? null : loaded.fixes[0] ?? null;
    if (loaded.fixes.length > 0) console.warn(LOG_PREFIX, 'repaired the stored tree:', loaded.fixes);

    const session = new Session(conversationId, store, panel, loaded.state, notice);
    session.#stopWatching = watchTranscript(() => session.refresh());
    session.refresh();
    return session;
  }

  /** Read the page, fold it into the tree, and draw it. */
  refresh(): void {
    if (this.#closed) return;

    // The address bar changes about 400 ms before the message list does.
    // Reading on that gap files one conversation's exchanges under another
    // conversation. The list itself says which conversation it belongs to,
    // so trust that and wait.
    const shown = conversationIdOfTranscript();
    if (shown !== null && shown !== this.conversationId) {
      this.#stale = true;
      this.draw();
      return;
    }
    if (shown === null && readTranscript().length > 0) {
      // Rows with no owner. Something changed in claude.ai. Do not store.
      this.#stale = true;
      this.draw();
      return;
    }
    this.#stale = false;

    const inputs: SyncInput[] = readExchanges().map((exchange) => ({
      turnId: exchange.turnId,
      questionText: questionTextOf(exchange),
      index: exchange.index,
    }));

    const result = syncWithTranscript(this.#state, inputs, Date.now());
    if (result.problems.length > 0) {
      console.warn(LOG_PREFIX, 'sync problems:', result.problems);
      this.#notice = result.problems[0] ?? null;
    }
    if (result.state !== this.#state) {
      this.#state = result.state;
      this.#store.saveSoon(this.#state);
    }
    this.draw();
  }

  draw(): void {
    this.#markBusy();
    this.#panel.render(this.#viewNow());
  }

  /**
   * Say on the page what the extension is doing.
   *
   * It costs one attribute and it makes the hard faults visible. A reader,
   * and tools/diag-flap.mjs, can then see whether a link moved while the
   * extension was moving the view, which it must never do.
   */
  #markBusy(): void {
    const root = document.documentElement;
    const busy = this.#jumping ? 'jump' : (this.#sweeping ? 'sweep' : '');
    if (busy === '') root.removeAttribute('data-claude-tree-busy');
    else root.setAttribute('data-claude-tree-busy', busy);
  }

  #viewNow(): PanelView {
    const loaded = loadedMessageCount();
    const coverage: Coverage | null = loaded === null ? null : {
      drawnRows: readTranscript().length,
      loadedMessages: loaded,
      // claude.ai loads the history a piece at a time, and it never draws
      // the whole of a long conversation at once. So the number of drawn
      // rows says nothing about whether older messages are left. Only a
      // full load that came back with nothing new can settle it.
      olderMayExist: this.#moreMayExist,
      loading: this.#sweeping,
    };
    const all = linearize(this.#state);
    const linkedCount = all.filter((row) => isLinked(this.#state, row.node.id)).length;
    return {
      rows: this.#onlyLinked ? linearize(this.#state, { onlyLinked: true }) : all,
      pendingParentId: this.#state.pendingParentId,
      activeTurnId: this.#stale ? null : visibleTurnId(),
      notice: this.#stale ? 'waiting for this conversation to load ...' : this.#notice,
      coverage: this.#stale ? null : coverage,
      linkingChildId: this.#linkingChildId,
      onlyLinked: this.#onlyLinked,
      totalCount: all.length,
      linkedCount,
    };
  }

  // ------------------------------------------------- linking, after the event

  /** Start giving `turnId` a parent. Every other row becomes a target. */
  startLink(turnId: string): void {
    if (getNode(this.#state, turnId) === null) return;
    this.#linkingChildId = turnId;
    this.#notice = null;
    this.draw();
  }

  cancelLink(): void {
    this.#linkingChildId = null;
    this.draw();
  }

  /** Put the exchange being linked under `parentId`. */
  pickParent(parentId: string): void {
    const childId = this.#linkingChildId;
    if (childId === null) return;
    this.#applyLink(childId, parentId);
  }

  /** Let the exchange being linked stand on its own again. */
  makeRoot(): void {
    const childId = this.#linkingChildId;
    if (childId === null) return;
    this.#applyLink(childId, null);
  }

  #applyLink(childId: string, parentId: string | null): void {
    const result = setParent(this.#state, childId, parentId, Date.now());
    this.#linkingChildId = null;
    if (!result.ok) {
      this.#notice = result.error.code === 'WOULD_CREATE_CYCLE'
        ? 'that exchange already hangs under this one, so the link would run in a ring.'
        : `could not make that link: ${result.error.code}`;
      this.draw();
      return;
    }
    this.#state = result.value;
    this.#notice = null;
    this.#store.saveSoon(this.#state);
    this.draw();
  }

  toggleFilter(): void {
    this.#onlyLinked = !this.#onlyLinked;
    this.draw();
  }

  choose(turnId: string): void {
    this.#linkingChildId = null;
    const next = turnId === this.#state.pendingParentId
      ? setPendingParent(this.#state, null, Date.now())
      : setPendingParent(this.#state, turnId, Date.now());
    if (!next.ok) {
      console.warn(LOG_PREFIX, 'could not choose that node:', next.error);
      this.#notice = `could not choose that node: ${next.error.code}`;
      this.draw();
      return;
    }
    this.#state = next.value;
    this.#notice = null;
    this.#store.saveSoon(this.#state);
    this.draw();
  }

  clearChoice(): void {
    const next = setPendingParent(this.#state, null, Date.now());
    if (!next.ok) return;
    this.#state = next.value;
    this.#store.saveSoon(this.#state);
    this.draw();
  }

  /**
   * Which way does this exchange lie from the one on screen?
   *
   * The tree knows the order of the exchanges. The page does not: its row
   * numbers move every time claude.ai loads older messages, so a number
   * stored yesterday means nothing today.
   */
  #directionTo(turnId: string): ScrollDirection {
    const rows = linearize(this.#state);
    const here = visibleTurnId();
    const target = rows.findIndex((row) => row.node.id === turnId);
    const current = here === null ? -1 : rows.findIndex((row) => row.node.id === here);
    if (target < 0 || current < 0) return 'up';
    return target < current ? 'up' : 'down';
  }

  /**
   * Stop whatever is moving the view, and take it over.
   *
   * It returns the new controller, not just its signal. The caller needs
   * the controller itself to ask, when it finishes, whether it is still
   * the one in charge.
   */
  #takeOver(): AbortController {
    this.#move?.abort();
    const controller = new AbortController();
    this.#move = controller;
    return controller;
  }

  async jump(turnId: string): Promise<void> {
    const controller = this.#takeOver();
    const direction = this.#directionTo(turnId);
    this.#jumping = true;
    this.#sweeping = false;
    this.#notice = 'looking for that exchange ...';
    this.draw();

    const result = await scrollToTurn(turnId, { direction, signal: controller.signal });

    // Clear the flag only if this jump is still the one in charge. A jump
    // that was cancelled must not clear it, because the jump that replaced
    // it is still running and still needs the guard.
    if (this.#move === controller) this.#jumping = false;

    if (result.gaveUpBecause === 'cancelled') {
      // Another jump took over. It owns the panel now, so say nothing.
      return;
    }
    if (!result.found) {
      // The exchange can be in the tree and gone from the conversation.
      // claude.ai gives a message a new id when you edit or retry it, and
      // the old one is never drawn again. Say so, rather than blaming the
      // scroll.
      this.#notice = result.gaveUpBecause === 'reached-the-end'
          || result.gaveUpBecause === 'took-too-long'
        ? 'that exchange is not in this conversation any more. '
          + 'Editing or retrying a message gives it a new id. Use "relink" or remove the row.'
        : 'could not reach that exchange. Scroll the chat a little, then try again.';
      this.draw();
      return;
    }
    if (result.gaveUpBecause === 'never-settled') {
      this.#notice = 'the chat kept loading while it moved. The exchange may be off centre.';
    }
    const row = findRowByTurnId(turnId, 'human');
    if (row !== null) flashRow(row, FLASH_CLASS);
    this.#notice = null;
    this.draw();
  }

  /**
   * Read the whole conversation, so the tree holds every exchange.
   *
   * It climbs to the start and walks back to the end. The walk back is not
   * a waste: claude.ai drops the rows in the middle of a long conversation,
   * so a pair of neighbours is often never on the page at the same time
   * until something moves over them.
   */
  async buildFullTree(): Promise<void> {
    const controller = this.#takeOver();
    this.#sweeping = true;
    this.#jumping = false;
    this.#notice = 'reading the whole conversation ...';
    this.draw();

    const result = await sweepConversation({
      signal: controller.signal,
      onProgress: (progress) => {
        // This read is the point of the sweep. Every step teaches the tree
        // which exchange follows which.
        this.refresh();
        const percent = Math.round(progress.position * 100);
        this.#notice = progress.phase === 'up'
          ? `loading older exchanges ... ${progress.loaded} messages`
          : `reading the conversation ... ${percent}%`;
        this.#panel.render(this.#viewNow());
      },
    });

    if (this.#move === controller) this.#sweeping = false;
    if (result.cancelled) {
      // A jump took over. Leave the panel to it.
      return;
    }
    this.#moreMayExist = !result.reachedTheStart;
    this.#notice = result.reachedTheStart
      ? null
      : 'claude.ai stopped before the start. Press it again to go on.';
    this.refresh();
  }

  async close(): Promise<void> {
    this.#closed = true;
    // Moving the view of a conversation we have left would be wrong, and
    // its reads would land in the next conversation's tree.
    this.#move?.abort();
    this.#move = null;
    this.#jumping = false;
    this.#sweeping = false;
    document.documentElement.removeAttribute('data-claude-tree-busy');
    this.#stopWatching?.();
    this.#stopWatching = null;
    await this.#store.flush();
  }
}

async function boot(): Promise<void> {
  await whenBodyReady();
  installFlashStyle();

  const store = new TreeStore(pickArea());
  let session: Session | null = null;

  const panel = new TreePanel({
    onJump: (turnId) => { void session?.jump(turnId); },
    onBranch: (turnId) => { session?.choose(turnId); },
    onClearPending: () => { session?.clearChoice(); },
    onStartLink: (turnId) => { session?.startLink(turnId); },
    onPickParent: (parentId) => { session?.pickParent(parentId); },
    onMakeRoot: () => { session?.makeRoot(); },
    onCancelLink: () => { session?.cancelLink(); },
    onToggleFilter: () => { session?.toggleFilter(); },
    onLoadOlder: () => { void session?.buildFullTree(); },
    onToggle: (open) => { if (open) session?.refresh(); },
  });
  panel.mount(document.body);

  const apply = async (): Promise<void> => {
    const id = conversationIdFromUrl();
    if (session !== null && session.conversationId === id) return;
    if (session !== null) {
      await session.close();
      session = null;
    }
    if (id === null) {
      panel.render({
        rows: [], pendingParentId: null, activeTurnId: null, notice: null, coverage: null,
        linkingChildId: null, onlyLinked: false, totalCount: 0, linkedCount: 0,
      });
      return;
    }
    session = await Session.open(id, store, panel);
  };

  await apply();
  watchLocation(() => { void apply(); });

  // A new conversation renders its first row a moment after the route change,
  // so look again a few times before the watcher takes over.
  for (const delay of [600, 1500, 3000]) {
    setTimeout(() => { void apply().then(() => session?.refresh()); }, delay);
  }

  window.addEventListener('pagehide', () => { void session?.close(); });
  console.log(LOG_PREFIX, 'ready');
}

void boot();
