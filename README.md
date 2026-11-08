# Claude Conversation Tree

A browser extension for claude.ai. It shows the questions and answers of one
conversation as a tree, and it lets you say which exchange each question
depends on.

claude.ai shows a conversation as one straight line. Often it is not one.
You read an answer, three separate questions come to mind, and all three
depend on that one answer, not on each other. This extension records that
shape and draws it.

## What a node is

A **node** is one exchange: one question and the reply to it.
A node's **parent** is the exchange it depends on.

claude.ai gives each exchange a stable id in the page, in the attribute
`data-turn-key`. The id survives a page reload, so the tree survives too.

## The one rule that matters

**Only you make a link. The extension never works one out for itself.**

A conversation with no links is a list of separate exchanges, each a tree of
one node. You make a link after the event, in two presses:

1. Press **set parent...** on the exchange that depends on another one.
2. Press **put it here** on the exchange it depends on.

Nothing else creates, moves or removes a link.

The order of those two presses is the whole interface. The button sits on
the **child**, and it asks for that child's parent. It runs one way only.

An earlier panel had a second button beside it, which named the parent and
then waited for a question you had not asked yet. The two buttons looked
alike and ran in opposite directions, so only a reader who already knew the
difference could use the panel. That button is gone. You ask the question
first, you read the reply, and then you say what it hangs under.

That rule is not a simplification; it is the design. An earlier version read
the order of the rows and worked out which exchange followed which. Every
fault this project has had came from that guess, because claude.ai:

- draws only part of a long conversation and drops the rows in the middle,
- renumbers every row when it loads older messages,
- changes the address about 400 ms before it changes the message list,
- and can be read while it is halfway through a change.

A guess made from such a page is wrong often enough that links moved about
on their own while you scrolled. Removing the guess removed the whole class
of fault, and about a third of the code with it.

## What the panel looks like

```
+- CONVERSATION TREE        4 exchanges  [all|linked]  x -+
| NEW  what about Firefox?       [set parent...] [dismiss]|
+---------------------------------------------------------+
| why use a shadow root at all?                           |
|   2 follow-ups                            [set parent...]
| |- does the page CSS leak in?             [set parent...]
| |- how do I test the manifest?            [set parent...]
| what about Firefox?                       [set parent...]
+---------------------------------------------------------+
```

One press of **set parent...** turns the list into a set of targets:

```
+- CONVERSATION TREE                                   x -+
| pick the parent of: what about Firefox?               |
|                            [no parent] [cancel]         |
+---------------------------------------------------------+
| why use a shadow root at all?               [put it here]
| |- does the page CSS leak in?               [put it here]
| |- how do I test the manifest?              [put it here]
| what about Firefox?   <- grey, and not a target          |
+---------------------------------------------------------+
```

`Escape` leaves that state, and so does closing the panel.

## What it does

- List every exchange, so you can tie any of them together later.
- Draw the trees you build, and indent only where one really splits.
- Show every exchange, or only the linked ones: press **all** or **linked**.
  The filled segment is what the list shows now.
- Jump the chat to an exchange when you click its row.
- Pull in a whole long conversation with **load older**, so every exchange
  is listed.
- Note each new exchange once, and offer the link for it. Ignore the note,
  and that exchange stands on its own, which it already does.
- Offer **undo** for ten seconds after each link.
- Keep one tree per conversation, in the browser's own storage.

The panel holds no choice between two questions. Every state in it is on
the screen now, or it is gone: the pick bar, the note and the undo all end
by themselves, and closing the panel gives up the pick bar.

## What it does not do

The tree is a record of your own intent. It does **not** change what the
model reads. If you link a question to an early exchange, the model still
sees the whole conversation. A real branch needs claude.ai's own branching,
which this version does not drive.

## Install from a release

Use this part on a new computer. It needs no checkout, no Node and no build.

Download the newest zip from
<https://github.com/ChaoLiou/claude-conversation-tree/releases/latest>.

### Chrome, Edge, Brave

1. Download `claude-conversation-tree-chrome-v<version>.zip`.
2. Unzip it into a folder that you keep. Chrome reads the folder on every
   start. The extension stops if you delete the folder.
3. Open `chrome://extensions`.
4. Turn on **Developer mode**.
5. Press **Load unpacked**.
6. Choose the folder from step 2.
7. Open a conversation on claude.ai.

Chrome shows a note about a developer-mode extension on each start. That note
is normal for an extension outside the store.

To update, unzip the new release over the same folder. Then press the reload
arrow on `chrome://extensions`.

### Firefox

1. Download `claude-conversation-tree-firefox-v<version>.zip`.
2. Unzip it into a folder.
3. Open `about:debugging#/runtime/this-firefox`.
4. Press **Load Temporary Add-on**.
5. Choose `manifest.json` in the folder from step 2.

Firefox removes a temporary add-on at exit. Load it again after a restart.
A permanent install needs a signature from addons.mozilla.org.

## Publish a new version

The workflow in `.github/workflows/release.yml` makes the release. A tag
starts it. The steps are:

1. Change `version` in `package.json`.
2. Commit the change.
3. Tag the commit: `git tag v0.2.0`.
4. Push both: `git push origin main --tags`.

The workflow checks the types, runs the tests, builds both targets, and
attaches the two zip files to the release. The workflow stops if the tag and
`package.json` do not agree. `package.json` is the one place that holds the
version, because `tools/build.mjs` reads it for the manifest.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm test` | Unit tests. No browser needed. |
| `pnpm typecheck` | TypeScript, in strict mode. |
| `pnpm check:tools` | Parse every file in `tools/`. They are plain JavaScript, so `tsc` never sees them. |
| `pnpm build` | Build `dist/chrome/` and `dist/firefox/`. |
| `pnpm build:watch` | Rebuild on every change. |
| `pnpm dev:chrome` | Start a separate Chrome with the DevTools port open. |
| `pnpm dev:chrome:stop` | Close that Chrome. |
| `pnpm inject` | Put the build into the open claude.ai tab, with no install. |
| `pnpm verify` | Drive the real page and check the whole feature. |
| `pnpm probe` | Read claude.ai's markup and write a report. |
| `pnpm probe:net` | Record claude.ai's network calls, across every realm. |
| `pnpm probe:keys` | Check that `data-turn-key` survives a reload. |
| `pnpm verify:long` | The slow one: lazy loading and jumps in a long conversation. Run it when the adapter changed. |

`pnpm verify:long` only reads and scrolls conversations that already
exist. It sends nothing.

Most behaviour is covered by `pnpm test`, which needs no browser and
finishes in about a second. The two browser suites exist for what a test
DOM cannot show: claude.ai's real timing, its part drawn message list, and
its renumbering. Run them when the adapter or the panel changed, not after
editing a test.

`pnpm verify` and `pnpm probe` **send real messages** to your Claude account
and start a new conversation each run. Each message is a few words. Delete
the test conversations when you have finished.

## The development loop

The code lives in WSL. Chrome runs on Windows. WSL runs in mirrored network
mode here, so `127.0.0.1` reaches both ways, and the tools drive Chrome over
the DevTools protocol from WSL.

```
pnpm dev:chrome      # once; sign in to claude.ai in that window, once
pnpm build
pnpm verify          # repeat as often as you like
```

Current Chrome refuses to load an unpacked extension from the command line,
and its `Extensions.loadUnpacked` protocol command returns an id without
registering anything. So the tools inject the built bundle over the protocol
instead. That covers the adapter, the sync rules and the panel against the
real markup. It does not cover the manifest or `browser.storage`, which the
unit tests cover.

## Installing your own build

This part installs the folder that `pnpm build` writes. For a computer
without a checkout, read **Install from a release** above.

1. Run `pnpm build`.
2. Copy `dist/chrome/` to a folder outside the checkout. `pnpm build` empties
   `dist/` on each run, so Chrome loses the extension if you point it there.
3. Open `chrome://extensions`, turn on developer mode.
4. Click **Load unpacked**, and pick that folder.

Step 4 opens a native folder picker, which no script can drive. It is a
one-time step.

For Firefox, load `dist/firefox/manifest.json` from
`about:debugging#/runtime/this-firefox`. `web-ext run` can also install and
reload the add-on without a click, including on a phone over USB.

## Layout

```
src/core/      the tree, the sync rules, storage. Pure. No DOM.
src/adapter/   the only module that knows claude.ai's markup.
src/ui/        the panel. It lives in a shadow root.
src/content.ts the content script. It joins the three together.
mock/          markup that copies claude.ai, for the tests.
tools/         the development loop: Chrome, probes, verify, build.
tests/         unit tests.
```

When claude.ai changes its markup, `src/adapter/dom.ts` is the only file to
repair. Run `pnpm probe` first, to see what changed.

## Where the selectors came from

Not from a guess. `tools/probe-run.mjs` drives the real site, sends marked
messages, and reports the element that holds each mark. The findings, from
2026-11-06:

```
[role="feed"][data-perf-region="transcript"]        the message list
└ [data-testid="transcript-row"]                    one per message
    data-perf-row="human" | "assistant"             the role
    data-index="0".."N"                             the position
  └ [role="article"]
    └ [data-transcript-row]
      ├ h3[data-find-omitted]                       a copy for a screen reader
      └ [data-user-scope] | [data-reply-scope]
        └ [data-cds="UserMessage"][data-turn-key]   the stable id, and the text
[data-autoscroll-container="true"]                  the element that scrolls
```

A question's turn key is `<uuid>`. Its reply's key is `<uuid>-hub-reply`.
One uuid therefore names one exchange. The key survives a page reload,
which is why the tree can store it.

## Six traps in claude.ai's page

The extension no longer reads links from the page, so most of these can no
longer corrupt anything. They still shape what the adapter may believe.

**1. The address changes about 400 ms before the message list does.**

Move from conversation A to conversation B and, for a moment, the address
says B while the list still shows A. Code that trusts the address files A's
exchanges under B. The element that wraps the list carries `data-conv-id`,
and that attribute does not move early. Trust it, not the address.

**2. `data-index` and `aria-setsize` count the loaded piece, not the
conversation.**

claude.ai fetches the history a piece at a time. Scrolling back prepends
older messages, `aria-setsize` grows, and every `data-index` moves with it.
A row that was index 0 a second ago is index 8 now. The extension uses
these numbers to sort the list and for nothing else, so a stale one makes
the order look odd for a moment and can break nothing.

**3. claude.ai never draws the whole of a long conversation.**

It keeps the rows at each end and drops the middle, for example `0..3` and
then `31..33`, with nothing between. An exchange is added to the tree only
while its row is drawn, which is why **load older** exists.

**4. A read can catch the page halfway through a change.**

A row can be in the DOM before its attributes are. Treat a missing value as
unknown, never as a convenient default.

**5. An exchange can be in the tree and gone from the conversation.**

Edit or retry a message and claude.ai gives it a new `data-turn-key`. The
old one is never drawn again, so a node that holds it can never be found,
however far the page scrolls. A search for a row therefore needs a
deadline, and the panel says the exchange is gone rather than blaming the
scroll.

**6. `scrollIntoView` moves the target.**

Putting an old exchange in the middle makes claude.ai fetch the messages
before it, which makes the page taller and pushes the exchange away again.
One call is never enough. Re-aim until the offset is small and the number
of drawn rows has stopped changing, and let a later jump cancel an earlier
one, or two loops drag the page in two directions at once.

Two more rules that each cost a day to learn. An end test must ask whether
the view can still move (`scrollTop <= 1`), never whether the whole page
fits on screen: in a long chat it never does, so the search pushes against
the top until its attempts run out. And a search must try both directions,
because the direction comes from the tree's idea of the order, which can
be out of date.

## Checks must read the stated structure

Five faults in this project turned out to be the check lying, not the code:

- counting indent columns to count roots (a perfect chain and a forest both
  draw no indent),
- matching a row by its label (the label has its blank space collapsed),
- halving the message count to get the exchange count (a reply that carries
  a card or a tool result takes more than one row),
- clicking row zero and then looking for a different row,
- demanding that an exchange at the very start of a chat be centred, which
  the top of the scroll area makes impossible.

Each came from reading something indirect. The panel states what it means,
so a check reads that.

## The panel states its own structure

Each row carries the shape of the tree in its markup:

```html
<div class="row" data-turn="<uuid>" data-depth="2" data-indent="1"
     data-root="false" data-children="0">
```

A check must read these, never the indent columns. The two are not the same
thing, and reading the columns gave one test a false result: a perfect chain
of seventeen nodes draws no indent at all, and so does a forest of seventeen
roots. `data-root` separates them.

## How the panel indents

An indent means one thing: this exchange hangs under the row above it.

The roots are a list, not a split, so they never indent. Most exchanges in
a chat are tied to nothing, and indenting them all would push every row one
column right and say nothing. A node that is an only child also sits level
with its parent, because a chain of single steps drawn as a staircase
wastes the whole width.

claude.ai sends a message over Connect RPC with a protobuf body, at
`/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction`.
This extension never touches that. It only reads the page.
