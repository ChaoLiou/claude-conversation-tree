// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTranscriptHtml, fakeUuid, sampleTurns } from '../mock/fixture.js';
import {
  conversationIdFromUrl,
  conversationIdOfTranscript,
  renderedIndexRange,
  scrollToTurn,
  sweepConversation,
  loadedMessageCount,
  findComposer,
  findFeed,
  findRowByTurnId,
  isConversationPage,
  normaliseTurnKey,
  questionTextOf,
  readExchanges,
  readTranscript,
  textOfRow,
  watchTranscript,
  REPLY_SUFFIX,
} from '../src/adapter/dom.js';

function mount(count: number): void {
  document.body.innerHTML = buildTranscriptHtml(sampleTurns(count));
}

describe('conversationIdFromUrl', () => {
  it('reads the uuid of a conversation page', () => {
    const id = '0199f2c1-aaaa-4bbb-8ccc-0123456789ab';
    expect(conversationIdFromUrl(`https://claude.ai/chat/${id}`)).toBe(id);
    expect(isConversationPage(`https://claude.ai/chat/${id}`)).toBe(true);
  });

  it('returns null on a page that is not a conversation', () => {
    expect(conversationIdFromUrl('https://claude.ai/new')).toBeNull();
    expect(conversationIdFromUrl('https://claude.ai/projects')).toBeNull();
    expect(isConversationPage('https://claude.ai/new')).toBe(false);
  });
});

describe('normaliseTurnKey', () => {
  it('keeps a bare uuid', () => {
    const id = fakeUuid(7);
    expect(normaliseTurnKey(id)).toBe(id);
  });

  it('strips the reply suffix, so both roles give one id', () => {
    const id = fakeUuid(7);
    expect(normaliseTurnKey(id + REPLY_SUFFIX)).toBe(id);
  });

  it('rejects a key that holds no uuid', () => {
    expect(normaliseTurnKey('some-client-id')).toBeNull();
    expect(normaliseTurnKey('')).toBeNull();
    expect(normaliseTurnKey(null)).toBeNull();
  });
});

describe('readTranscript', () => {
  beforeEach(() => mount(3));

  it('finds one row per message', () => {
    expect(readTranscript()).toHaveLength(6);
  });

  it('reads the role of each row', () => {
    const roles = readTranscript().map((r) => r.role);
    expect(roles).toEqual(['human', 'assistant', 'human', 'assistant', 'human', 'assistant']);
  });

  it('reads the position of each row', () => {
    expect(readTranscript().map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('gives a question and its reply the same id', () => {
    const rows = readTranscript();
    expect(rows[0]?.turnId).toBe(rows[1]?.turnId);
    expect(rows[2]?.turnId).toBe(rows[3]?.turnId);
  });

  it('reports a row that streams', () => {
    expect(readTranscript().every((r) => r.streaming === false)).toBe(true);
  });
});

describe('readExchanges', () => {
  it('pairs every question with its reply, in page order', () => {
    mount(3);
    const exchanges = readExchanges();
    expect(exchanges).toHaveLength(3);
    expect(exchanges.map((e) => e.turnId)).toEqual([fakeUuid(1), fakeUuid(2), fakeUuid(3)]);
    for (const exchange of exchanges) {
      expect(exchange.question).not.toBeNull();
      expect(exchange.reply).not.toBeNull();
    }
  });

  it('keeps an exchange whose reply has not arrived yet', () => {
    mount(1);
    const reply = document.querySelector('[data-perf-row="assistant"]');
    reply?.remove();
    const exchanges = readExchanges();
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.question).not.toBeNull();
    expect(exchanges[0]?.reply).toBeNull();
  });

  it('skips a row that carries no id', () => {
    mount(2);
    const keyed = document.querySelector('[data-turn-key]');
    keyed?.removeAttribute('data-turn-key');
    // The question of turn 1 loses its id, so only its reply names turn 1.
    const exchanges = readExchanges();
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]?.question).toBeNull();
    expect(exchanges[0]?.reply).not.toBeNull();
  });

  it('returns nothing on a page with no message list', () => {
    document.body.innerHTML = '<div>nothing here</div>';
    expect(readExchanges()).toEqual([]);
    expect(findFeed()).toBeNull();
  });
});

describe('text reading', () => {
  beforeEach(() => mount(2));

  it('leaves out the copy that exists for a screen reader', () => {
    // A row holds a heading that repeats the message with a spoken prefix.
    // Reading the row itself would give the text twice.
    const rows = readTranscript();
    const text = textOfRow(rows[0]!);
    expect(text).toBe('question number 1: how does part 1 work?');
    expect(text).not.toContain('You said:');
    expect(text.indexOf('question number 1')).toBe(text.lastIndexOf('question number 1'));
  });

  it('reads a reply without its spoken prefix', () => {
    const rows = readTranscript();
    const text = textOfRow(rows[1]!);
    expect(text).toBe('answer number 1. It works in this way.');
    expect(text).not.toContain('Claude said:');
  });

  it('still drops the spoken copy when the body wrapper is gone', () => {
    // claude.ai may rename the wrapper. The fallback must still be clean.
    for (const el of document.querySelectorAll('[data-user-scope]')) {
      const parent = el.parentElement;
      while (el.firstChild !== null) parent?.insertBefore(el.firstChild, el);
      el.remove();
    }
    const text = textOfRow(readTranscript()[0]!);
    expect(text).not.toContain('You said:');
    expect(text).toContain('question number 1');
    expect(text.indexOf('question number 1')).toBe(text.lastIndexOf('question number 1'));
  });

  it('leaves out the action buttons and their tooltip', () => {
    const text = textOfRow(readTranscript()[0]!);
    expect(text).not.toContain('send now');
    expect(text).not.toContain('Ctrl+Enter');
    expect(text).toBe('question number 1: how does part 1 work?');
  });

  it('leaves out the glyphs that an icon font draws', () => {
    const text = textOfRow(readTranscript()[0]!);
    expect(text).not.toMatch(/[\uE000-\uF8FF]/);
  });

  it('keeps a gap between two blocks of text', () => {
    const body = document.querySelector('[data-user-scope]');
    if (body === null) throw new Error('no message body in the fixture');
    body.innerHTML = '<div><p>first line</p><p>second line</p></div>';
    const text = textOfRow(readTranscript()[0]!);
    expect(text).toBe('first line second line');
  });

  it('collapses the blank space of a row', () => {
    const rows = readTranscript();
    const text = textOfRow(rows[0]!);
    expect(text).toContain('question number 1');
    expect(text).not.toMatch(/\s{2,}/);
  });

  it('takes the question text of an exchange', () => {
    const exchanges = readExchanges();
    expect(questionTextOf(exchanges[1]!)).toContain('question number 2');
  });

  it('gives an empty string when the question is gone', () => {
    const question = document.querySelector('[data-perf-row="human"]');
    question?.remove();
    const exchanges = readExchanges();
    expect(questionTextOf(exchanges[0]!)).toBe('');
  });
});

describe('findRowByTurnId', () => {
  beforeEach(() => mount(3));

  it('finds the question row by default', () => {
    const row = findRowByTurnId(fakeUuid(2));
    expect(row?.role).toBe('human');
    expect(row?.index).toBe(2);
  });

  it('finds the reply row when asked', () => {
    const row = findRowByTurnId(fakeUuid(2), 'assistant');
    expect(row?.role).toBe('assistant');
    expect(row?.index).toBe(3);
  });

  it('falls back to the other role when the asked one is gone', () => {
    document.querySelectorAll('[data-perf-row="human"]').forEach((el) => el.remove());
    const row = findRowByTurnId(fakeUuid(2), 'human');
    expect(row?.role).toBe('assistant');
  });

  it('returns null for an id the page does not hold', () => {
    expect(findRowByTurnId(fakeUuid(99))).toBeNull();
  });
});

describe('findComposer', () => {
  it('returns null when no box has a size', () => {
    // happy-dom reports a zero size, so the guard must reject the box.
    mount(1);
    expect(findComposer()).toBeNull();
  });
});

describe('watchTranscript', () => {
  it('fires once after a quiet moment, not once per change', async () => {
    mount(1);
    let calls = 0;
    const stop = watchTranscript(() => { calls++; }, { quietMs: 40 });

    const sizer = document.querySelector('[data-testid="transcript-sizer"]');
    for (let i = 0; i < 5; i++) {
      const extra = document.createElement('div');
      extra.textContent = 'more';
      sizer?.appendChild(extra);
    }

    await new Promise((r) => setTimeout(r, 150));
    stop();
    expect(calls).toBe(1);
  });

  it('stops firing after you stop it', async () => {
    mount(1);
    let calls = 0;
    const stop = watchTranscript(() => { calls++; }, { quietMs: 20 });
    stop();
    document.querySelector('[data-testid="transcript-sizer"]')?.appendChild(document.createElement('div'));
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(0);
  });
});

describe('which conversation the message list belongs to', () => {
  it('reads the id from the element that wraps the list', () => {
    const id = fakeUuid(42);
    document.body.innerHTML = buildTranscriptHtml(sampleTurns(2), { conversationId: id });
    expect(conversationIdOfTranscript()).toBe(id);
  });

  it('returns null when no list is on the page', () => {
    document.body.innerHTML = '<div>nothing here</div>';
    expect(conversationIdOfTranscript()).toBeNull();
  });

  it('tells a stale list apart from the address bar', () => {
    // This is the real failure. claude.ai changes the address about 400 ms
    // before it changes the list, so the two disagree for a moment.
    const oldId = fakeUuid(1);
    const newId = fakeUuid(2);
    document.body.innerHTML = buildTranscriptHtml(sampleTurns(2), { conversationId: oldId });
    expect(conversationIdOfTranscript()).toBe(oldId);
    expect(conversationIdFromUrl(`https://claude.ai/chat/${newId}`)).toBe(newId);
    expect(conversationIdOfTranscript()).not.toBe(newId);
  });
});

describe('how much of the conversation the page holds', () => {
  it('reports what claude.ai currently holds, which is not the total', () => {
    document.body.innerHTML = buildTranscriptHtml(sampleTurns(2), {
      totalMessages: 32,
      firstIndex: 28,
    });
    expect(loadedMessageCount()).toBe(32);
  });

  it('reports the span of the drawn rows', () => {
    document.body.innerHTML = buildTranscriptHtml(sampleTurns(2), {
      totalMessages: 32,
      firstIndex: 28,
    });
    expect(renderedIndexRange()).toEqual({ min: 28, max: 31, count: 4 });
  });

  it('reports nothing when the page holds no rows', () => {
    document.body.innerHTML = '<div>nothing here</div>';
    expect(loadedMessageCount()).toBeNull();
    expect(renderedIndexRange()).toBeNull();
  });

  it('gives each exchange the place the page drew it', () => {
    document.body.innerHTML = buildTranscriptHtml(sampleTurns(2), {
      totalMessages: 32,
      firstIndex: 28,
    });
    expect(readExchanges().map((e) => e.index)).toEqual([28, 30]);
  });
});

describe('a move of the view can be cancelled', () => {
  beforeEach(() => mount(3));

  it('gives up at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await scrollToTurn(fakeUuid(2), { signal: controller.signal });
    expect(result.gaveUpBecause).toBe('cancelled');
    expect(result.found).toBe(false);
  });

  it('gives up even when the row is on the page', async () => {
    // The row is here, so without the signal this would start to settle.
    expect(findRowByTurnId(fakeUuid(1))).not.toBeNull();
    const controller = new AbortController();
    controller.abort();
    const result = await scrollToTurn(fakeUuid(1), { signal: controller.signal });
    expect(result.gaveUpBecause).toBe('cancelled');
  });

  it('stops quickly when a later action cancels it', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running = scrollToTurn(fakeUuid(1), {
      signal: controller.signal,
      // A long budget, so only the cancel can end this.
      settleBudgetMs: 20000,
      waitMs: 60,
    });
    setTimeout(() => controller.abort(), 120);
    const result = await running;
    expect(result.gaveUpBecause).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('runs to an answer when nothing cancels it', async () => {
    const result = await scrollToTurn(fakeUuid(1), { settleBudgetMs: 300, waitMs: 20 });
    expect(result.gaveUpBecause).not.toBe('cancelled');
  });

  it('cancels a sweep as well', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await sweepConversation({ signal: controller.signal });
    expect(result.cancelled).toBe(true);
  });
});

describe('a jump that cannot find its row', () => {
  /** Give the container a size, because a test DOM has no layout. */
  function sizedContainer(scrollHeight: number, clientHeight: number): HTMLElement {
    const container = document.querySelector<HTMLElement>('[data-autoscroll-container="true"]');
    if (container === null) throw new Error('no scroll container in the fixture');
    Object.defineProperty(container, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: clientHeight, configurable: true });
    return container;
  }

  it('gives up at the top instead of pushing against it', async () => {
    // This was a real fault. The end test asked whether the whole page
    // fitted on screen, which is never true in a long chat, so the search
    // pushed against the top for as long as its attempts lasted.
    mount(3);
    const container = sizedContainer(5000, 500);
    container.scrollTop = 0;

    const started = Date.now();
    // Enough attempts to walk the whole page both ways, so running out
    // cannot be mistaken for reaching the end.
    const result = await scrollToTurn(fakeUuid(99), {
      direction: 'up', attempts: 60, waitMs: 10, settleBudgetMs: 100,
    });

    expect(result.found).toBe(false);
    expect(result.gaveUpBecause).toBe('reached-the-end');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('turns round and looks the other way', async () => {
    mount(3);
    const container = sizedContainer(5000, 500);
    container.scrollTop = 0;

    await scrollToTurn(fakeUuid(99), {
      direction: 'up', attempts: 8, waitMs: 10, settleBudgetMs: 100,
    });

    // It started at the top, so the only way left to look was down.
    expect(container.scrollTop).toBeGreaterThan(0);
  });

  it('gives up at the bottom as well', async () => {
    mount(3);
    const container = sizedContainer(5000, 500);
    container.scrollTop = 4500;

    const result = await scrollToTurn(fakeUuid(99), {
      direction: 'down', attempts: 8, waitMs: 10, settleBudgetMs: 100,
    });
    expect(result.found).toBe(false);
    expect(container.scrollTop).toBeLessThan(4500);
  });

  it('finds a row that sits the other way from the guess', async () => {
    mount(3);
    const container = sizedContainer(5000, 500);
    container.scrollTop = 0;

    // The row is on the page, so the first look finds it whatever the
    // caller guessed about direction.
    const result = await scrollToTurn(fakeUuid(2), {
      direction: 'down', attempts: 8, waitMs: 10, settleBudgetMs: 100,
    });
    expect(result.found).toBe(true);
  });
});
