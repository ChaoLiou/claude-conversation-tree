/**
 * The tree panel.
 *
 * It lives in a shadow root, so claude.ai's stylesheet cannot reach it and
 * its own stylesheet cannot reach claude.ai. It holds no state of its own
 * beyond "open" or "closed": `render` draws whatever view you pass it.
 *
 * It uses no framework. The row list comes from `linearize`, which already
 * carries the indent depth and the guide lines, so a plain loop is enough.
 *
 * There is one way to make a link, and it runs in one direction. The button
 * on a row always asks for that row's parent. You press `set parent...` on
 * the child, and then you press `put it here` on the parent. The panel never
 * holds a choice for a question you have not asked yet.
 */

import type { FlatRow } from '../core/tree.js';

export interface PanelCallbacks {
  /** The user wants to see this exchange in the chat. */
  readonly onJump: (turnId: string) => void;
  /** The user wants to give this exchange a parent. */
  readonly onStartLink: (turnId: string) => void;
  /** The user picked the parent for the exchange being linked. */
  readonly onPickParent: (parentId: string) => void;
  /** The user wants the exchange being linked to stand on its own. */
  readonly onMakeRoot: () => void;
  /** The user gave up on linking. */
  readonly onCancelLink: () => void;
  /** The user chose which exchanges the list shows. */
  readonly onSetFilter: (onlyLinked: boolean) => void;
  /** The user wants the whole conversation read into the tree. */
  readonly onLoadOlder: () => void;
  /** The user wants the last link undone. */
  readonly onUndo: () => void;
  /** The user does not want the note about the new exchange. */
  readonly onDismissNudge: () => void;
  readonly onToggle: (open: boolean) => void;
}

/** The offer to undo the link that was just made. */
export interface UndoOffer {
  readonly childLabel: string;
  /** The new parent. `null` means the exchange became a root. */
  readonly parentLabel: string | null;
}

/**
 * A note that a new exchange joined the tree.
 *
 * A new exchange always stands on its own, so the panel says so once and
 * offers the link. The note disappears by itself. It is a note, not a mode:
 * there is no state to remember and nothing to undo if you ignore it.
 */
export interface Nudge {
  readonly turnId: string;
  readonly label: string;
}

export interface PanelView {
  readonly rows: readonly FlatRow[];
  /** The exchange the chat is looking at, for a highlight. */
  readonly activeTurnId: string | null;
  /** A short line for the user. `null` hides the strip. */
  readonly notice: string | null;
  /**
   * The exchange that is waiting for a parent, if you started a link.
   * While this is set, every other row is a target.
   */
  readonly linkingChildId: string | null;
  /** True while the panel hides the exchanges that stand alone. */
  readonly onlyLinked: boolean;
  /** How many exchanges the tree holds in all. */
  readonly totalCount: number;
  /** How many of them take part in a link. */
  readonly linkedCount: number;
  readonly undo: UndoOffer | null;
  readonly nudge: Nudge | null;
  /**
   * How much of the conversation claude.ai has drawn.
   *
   * claude.ai draws only the last few messages of a long conversation, so
   * the tree is short until you scroll back. Saying so stops that looking
   * like a fault.
   */
  readonly coverage: Coverage | null;
}

export interface Coverage {
  /** How many rows claude.ai has drawn. */
  readonly drawnRows: number;
  /** How many messages claude.ai holds for this conversation right now. */
  readonly loadedMessages: number;
  /**
   * True while older messages may still exist above what is loaded.
   *
   * claude.ai fetches the history a piece at a time, so the extension can
   * never say for certain that it has seen the start, until a full load
   * comes back with nothing new.
   */
  readonly olderMayExist: boolean;
  readonly loading: boolean;
}

const STYLE = `
:host {
  --bg: #ffffff;
  --fg: #1a1a19;
  --muted: #6b6b68;
  --line: #d8d8d4;
  --accent: #c25c3a;
  --accent-soft: #f6e6df;
  --shadow: 0 6px 28px rgba(0, 0, 0, 0.16);
  all: initial;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  :host {
    --bg: #262624;
    --fg: #f2f2ef;
    --muted: #a3a3a0;
    --line: #44443f;
    --accent: #e08a63;
    --accent-soft: #3b2e28;
    --shadow: 0 6px 28px rgba(0, 0, 0, 0.5);
  }
}
* { box-sizing: border-box; }

.toggle {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg);
  color: var(--fg);
  box-shadow: var(--shadow);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.toggle:hover { border-color: var(--accent); }
.toggle .count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  text-align: center;
}

.panel {
  position: fixed;
  z-index: 2147483000;
  display: none;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.panel.open { display: flex; }

/* A wide window docks the panel on the right. */
@media (min-width: 860px) {
  .panel {
    top: 16px;
    right: 16px;
    bottom: 16px;
    width: 340px;
    border-radius: 14px;
  }
}
/* A narrow window raises it from the bottom, clear of the keyboard. */
@media (max-width: 859px) {
  .panel {
    left: 0;
    right: 0;
    bottom: 0;
    max-height: 72vh;
    border-radius: 14px 14px 0 0;
    border-bottom: none;
  }
}

header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}
header h2 { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: 0.02em; }
header .spacer { flex: 1; }
header .meta { font-size: 11px; color: var(--muted); }
.iconbtn {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 18px;
  line-height: 1;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.iconbtn:hover { background: var(--accent-soft); color: var(--accent); }

/* Two segments, and the filled one is what the list shows now. One button
   that changes its own word cannot say whether the word is the state or
   the action. Two segments can. */
.seg {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 999px;
  overflow: hidden;
}
.seg-b {
  border: none;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 10.5px;
  padding: 3px 9px;
  cursor: pointer;
}
.seg-b:hover { color: var(--accent); }
.seg-b.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
  cursor: default;
}

.notice, .nudge, .undo, .linking {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  font-size: 12px;
  border-bottom: 1px solid var(--line);
}
.notice { color: var(--muted); line-height: 1.4; }
.notice .noticetext { flex: 1; }
.loadolder, .undobtn, .nudgelink, .nudgeoff {
  flex: 0 0 auto;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--fg);
  border-radius: 6px;
  padding: 3px 9px;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.loadolder:hover:not(:disabled),
.undobtn:hover,
.nudgelink:hover,
.nudgeoff:hover { border-color: var(--accent); color: var(--accent); }
.loadolder:disabled { opacity: 0.5; cursor: default; }
.loadolder[hidden] { display: none; }

.nudge .tag, .undo .tag {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.nudge .label, .undo .undotext {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The pick bar. It is loud on purpose: while it shows, every row in the
   list means something different, and the user must see that at a glance. */
.linking {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.linking .label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 400;
}
.linking button {
  flex: 0 0 auto;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  border-radius: 6px;
  padding: 2px 8px;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.list { flex: 1; overflow-y: auto; padding: 6px 0 14px; }
.empty { padding: 24px 16px; font-size: 12px; color: var(--muted); line-height: 1.6; }

.row { display: flex; align-items: stretch; min-height: 34px; }
.row:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
.row.active { background: var(--accent-soft); }
.row.target .jump { cursor: copy; }
.row.target:hover { background: var(--accent-soft); }
.row.linking-self { opacity: 0.45; }

.g, .elbow { flex: 0 0 15px; position: relative; }
.g.line::before, .elbow::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--line);
}
.elbow::before { bottom: auto; height: 17px; }
.elbow.more::before { height: 100%; }
.elbow::after {
  content: '';
  position: absolute;
  left: 7px;
  top: 17px;
  width: 8px;
  border-top: 1px solid var(--line);
}

.jump {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  padding: 5px 6px 5px 8px;
  border: none;
  background: transparent;
  color: var(--fg);
  text-align: left;
  font: inherit;
  font-size: 12.5px;
  line-height: 1.35;
  cursor: pointer;
}
.jump .text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.jump .kids { font-size: 10.5px; color: var(--muted); }

/* The row action stays visible. An action that appears on hover only is an
   action a new reader never finds, and on a touch screen there is no hover
   at all. */
.act {
  flex: 0 0 auto;
  align-self: center;
  margin-right: 10px;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.act:hover { border-color: var(--accent); color: var(--accent); }
.act.pick { border-color: var(--accent); color: var(--accent); }

/* The rules above set display on these strips, which beats the browser's
   own rule for the hidden attribute. State it again, last, or a cancelled
   choice keeps showing its strip. */
.notice[hidden], .nudge[hidden], .undo[hidden], .linking[hidden] { display: none; }
`;

/** One line that says the tree may not hold the whole conversation yet. */
function describeCoverage(coverage: Coverage | null): string | null {
  if (coverage === null) return null;
  if (coverage.loading) return 'reading the conversation ...';
  if (!coverage.olderMayExist) return null;
  return 'claude.ai draws a long conversation a piece at a time, '
    + 'so this tree may be missing older exchanges.';
}

export class TreePanel {
  readonly #callbacks: PanelCallbacks;
  #host: HTMLElement | null = null;
  #root: ShadowRoot | null = null;
  #toggle: HTMLButtonElement | null = null;
  #panel: HTMLElement | null = null;
  #list: HTMLElement | null = null;
  #meta: HTMLElement | null = null;
  #notice: HTMLElement | null = null;
  #nudge: HTMLElement | null = null;
  #undo: HTMLElement | null = null;
  #linking: HTMLElement | null = null;
  #segAll: HTMLButtonElement | null = null;
  #segOnly: HTMLButtonElement | null = null;
  #onKeyDown: ((event: KeyboardEvent) => void) | null = null;
  #open = false;
  #lastView: PanelView | null = null;

  constructor(callbacks: PanelCallbacks) {
    this.#callbacks = callbacks;
  }

  get open(): boolean {
    return this.#open;
  }

  mount(parent: HTMLElement): void {
    if (this.#host !== null) return;

    const host = document.createElement('div');
    host.id = 'claude-tree-panel-host';
    host.style.position = 'relative';
    host.style.zIndex = '2147483000';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);

    const toggle = document.createElement('button');
    toggle.className = 'toggle';
    toggle.type = 'button';
    toggle.innerHTML = '<span>Tree</span><span class="count">0</span>';
    toggle.addEventListener('click', () => this.setOpen(!this.#open));
    root.appendChild(toggle);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <header>
        <h2>CONVERSATION TREE</h2>
        <span class="spacer"></span>
        <span class="meta"></span>
        <span class="seg">
          <button class="seg-b all" type="button" title="show every exchange">all</button>
          <button class="seg-b only" type="button" title="show only the exchanges you tied together">linked</button>
        </span>
        <button class="iconbtn close" type="button" title="close">&times;</button>
      </header>
      <div class="linking" hidden>
        <span>pick the parent of:</span>
        <span class="label"></span>
        <button type="button" class="makeroot">no parent</button>
        <button type="button" class="cancellink">cancel</button>
      </div>
      <div class="nudge" hidden>
        <span class="tag">new</span>
        <span class="label"></span>
        <button type="button" class="nudgelink">set parent&hellip;</button>
        <button type="button" class="nudgeoff" title="leave it on its own">dismiss</button>
      </div>
      <div class="undo" hidden>
        <span class="undotext"></span>
        <button type="button" class="undobtn">undo</button>
      </div>
      <div class="notice" hidden>
        <span class="noticetext"></span>
        <button type="button" class="loadolder">load older</button>
      </div>
      <div class="list"></div>`;
    root.appendChild(panel);

    panel.querySelector('.close')?.addEventListener('click', () => this.setOpen(false));
    panel.querySelector('.loadolder')?.addEventListener('click', () => this.#callbacks.onLoadOlder());
    panel.querySelector('.all')?.addEventListener('click', () => this.#callbacks.onSetFilter(false));
    panel.querySelector('.only')?.addEventListener('click', () => this.#callbacks.onSetFilter(true));
    panel.querySelector('.makeroot')?.addEventListener('click', () => this.#callbacks.onMakeRoot());
    panel.querySelector('.cancellink')?.addEventListener('click', () => this.#callbacks.onCancelLink());
    panel.querySelector('.undobtn')?.addEventListener('click', () => this.#callbacks.onUndo());
    panel.querySelector('.nudgeoff')?.addEventListener('click', () => this.#callbacks.onDismissNudge());
    panel.querySelector('.nudgelink')?.addEventListener('click', () => {
      const id = this.#lastView?.nudge?.turnId ?? null;
      if (id !== null) this.#callbacks.onStartLink(id);
    });

    // Escape leaves the pick state. The page uses Escape for its own ends,
    // so take the key only while the pick state is really open.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (this.#lastView?.linkingChildId == null) return;
      event.stopPropagation();
      event.preventDefault();
      this.#callbacks.onCancelLink();
    };
    document.addEventListener('keydown', onKeyDown, true);
    this.#onKeyDown = onKeyDown;

    this.#host = host;
    this.#root = root;
    this.#toggle = toggle;
    this.#panel = panel;
    this.#list = panel.querySelector<HTMLElement>('.list');
    this.#meta = panel.querySelector<HTMLElement>('.meta');
    this.#notice = panel.querySelector<HTMLElement>('.notice');
    this.#nudge = panel.querySelector<HTMLElement>('.nudge');
    this.#undo = panel.querySelector<HTMLElement>('.undo');
    this.#linking = panel.querySelector<HTMLElement>('.linking');
    this.#segAll = panel.querySelector<HTMLButtonElement>('.seg-b.all');
    this.#segOnly = panel.querySelector<HTMLButtonElement>('.seg-b.only');

    parent.appendChild(host);
    if (this.#lastView !== null) this.render(this.#lastView);
  }

  unmount(): void {
    if (this.#onKeyDown !== null) {
      document.removeEventListener('keydown', this.#onKeyDown, true);
      this.#onKeyDown = null;
    }
    this.#host?.remove();
    this.#host = null;
    this.#root = null;
    this.#toggle = null;
    this.#panel = null;
    this.#list = null;
  }

  setOpen(open: boolean): void {
    this.#open = open;
    this.#panel?.classList.toggle('open', open);
    // A pick state that you cannot see is a pick state you forget. Closing
    // the panel gives it up.
    if (!open && this.#lastView?.linkingChildId != null) this.#callbacks.onCancelLink();
    this.#callbacks.onToggle(open);
  }

  render(view: PanelView): void {
    this.#lastView = view;
    if (this.#root === null || this.#list === null) return;

    const count = view.rows.length;
    const countEl = this.#toggle?.querySelector('.count');
    if (countEl !== null && countEl !== undefined) countEl.textContent = String(count);

    if (this.#meta !== null) {
      this.#meta.textContent = view.onlyLinked
        ? `${view.linkedCount} of ${view.totalCount}`
        : (view.totalCount === 1 ? '1 exchange' : `${view.totalCount} exchanges`);
    }

    this.#segAll?.classList.toggle('on', !view.onlyLinked);
    this.#segOnly?.classList.toggle('on', view.onlyLinked);

    const linking = view.linkingChildId !== null;

    if (this.#linking !== null) {
      const child = view.rows.find((r) => r.node.id === view.linkingChildId) ?? null;
      this.#linking.hidden = !linking;
      const label = this.#linking.querySelector('.label');
      if (label !== null) label.textContent = child?.node.label ?? '';
    }

    // The pick bar owns the panel while it is open. A second strip under it
    // would offer an action that the pick state cannot carry out.
    if (this.#nudge !== null) {
      const nudge = linking ? null : view.nudge;
      this.#nudge.hidden = nudge === null;
      const label = this.#nudge.querySelector('.label');
      if (label !== null) label.textContent = nudge?.label ?? '';
    }

    if (this.#undo !== null) {
      const undo = linking ? null : view.undo;
      this.#undo.hidden = undo === null;
      const text = this.#undo.querySelector('.undotext');
      if (text !== null && undo !== null) {
        // Name the parent only. Both labels in one line overflow the strip,
        // and the child is the row you just acted on.
        text.textContent = undo.parentLabel === null
          ? `${undo.childLabel}: no parent now`
          : `now under ${undo.parentLabel}`;
      }
    }

    const line = view.notice ?? describeCoverage(view.coverage);
    if (this.#notice !== null) {
      const text = this.#notice.querySelector('.noticetext');
      if (text !== null) text.textContent = line ?? '';
      this.#notice.hidden = line === null;
      const button = this.#notice.querySelector<HTMLButtonElement>('.loadolder');
      if (button !== null) {
        const offer = view.coverage !== null && view.coverage.olderMayExist;
        button.hidden = !offer;
        button.disabled = view.coverage?.loading === true;
      }
    }

    this.#list.replaceChildren();
    if (count === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = view.onlyLinked
        ? 'Nothing is tied together yet. Press "all" above to see every '
          + 'exchange. Then press "set parent" on one of them.'
        : 'No exchange yet. Ask something in the chat, and it appears here. '
          + 'Every exchange stands on its own until you press "set parent".';
      this.#list.appendChild(empty);
      return;
    }

    for (const row of view.rows) {
      this.#list.appendChild(this.#renderRow(row, view));
    }
  }

  #renderRow(row: FlatRow, view: PanelView): HTMLElement {
    const element = document.createElement('div');
    element.className = 'row';
    // State the shape of the tree in the markup. A reader, including the
    // check in tools/verify-nav.mjs, then reads the structure instead of
    // counting indent columns and guessing what they mean.
    element.dataset.turn = row.node.id;
    element.dataset.depth = String(row.depth);
    element.dataset.indent = String(row.indent);
    element.dataset.root = row.node.parentId === null ? 'true' : 'false';
    element.dataset.children = String(row.childCount);
    if (row.node.id === view.activeTurnId) element.classList.add('active');

    // A row at indent I needs exactly I columns. The first I-1 columns are
    // a line or a blank, one per branch above it. The last column holds the
    // elbow when this row is part of a branch, and a line when it only
    // continues one.
    const spacerCount = Math.max(0, row.indent - 1);
    for (let i = 0; i < spacerCount; i++) {
      const spacer = document.createElement('span');
      spacer.className = row.guides[i] === true ? 'g line' : 'g';
      element.appendChild(spacer);
    }
    if (row.indent > 0) {
      const last = document.createElement('span');
      if (row.isBranch) {
        last.className = row.isLastSibling ? 'elbow' : 'elbow more';
      } else {
        const stillOpen = row.guides[row.indent - 1] === true;
        last.className = stillOpen ? 'g line' : 'g';
      }
      element.appendChild(last);
    }

    const jump = document.createElement('button');
    jump.className = 'jump';
    jump.type = 'button';
    jump.title = row.node.label;
    const text = document.createElement('span');
    text.className = 'text';
    // The label holds the user's own words. Never build it as markup.
    text.textContent = row.node.label;
    jump.appendChild(text);
    if (row.childCount > 0) {
      const kids = document.createElement('span');
      kids.className = 'kids';
      kids.textContent = row.childCount === 1 ? '1 follow-up' : `${row.childCount} follow-ups`;
      jump.appendChild(kids);
    }
    jump.addEventListener('click', () => {
      // While a link is open, every row is a target. Clicking the text is
      // the quickest way to pick one, so make that work too.
      if (view.linkingChildId !== null && row.node.id !== view.linkingChildId) {
        this.#callbacks.onPickParent(row.node.id);
        return;
      }
      this.#callbacks.onJump(row.node.id);
    });
    element.appendChild(jump);

    const isSelf = row.node.id === view.linkingChildId;

    if (view.linkingChildId !== null) {
      element.classList.add(isSelf ? 'linking-self' : 'target');
      if (!isSelf) {
        const pick = document.createElement('button');
        pick.className = 'act pick';
        pick.type = 'button';
        pick.textContent = 'put it here';
        pick.title = 'the exchange in the bar above hangs under this one';
        pick.addEventListener('click', (event) => {
          event.stopPropagation();
          this.#callbacks.onPickParent(row.node.id);
        });
        element.appendChild(pick);
      }
      return element;
    }

    // One action, one direction: this row asks for its own parent. The
    // older panel had a second button that ran the other way, and the two
    // looked alike, so the direction was a guess.
    const setParent = document.createElement('button');
    setParent.className = 'act setparent';
    setParent.type = 'button';
    setParent.textContent = 'set parent…';
    setParent.title = row.node.parentId === null
      ? 'choose the exchange that this one hangs under'
      : 'choose another exchange for this one to hang under';
    setParent.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#callbacks.onStartLink(row.node.id);
    });
    element.appendChild(setParent);

    return element;
  }
}
