/**
 * Build markup that copies claude.ai's message list.
 *
 * The structure here came from tools/probe-run.mjs against the real site.
 * Both the adapter tests and the mock page use this builder, so a test and
 * the mock can never drift apart.
 */

export interface FixtureTurn {
  /** The bare uuid that claude.ai would give this exchange. */
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly streaming?: boolean;
}

export function fakeUuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function row(
  turnKey: string,
  role: 'human' | 'assistant',
  index: number,
  total: number,
  text: string,
  streaming: boolean,
): string {
  const scope = role === 'human' ? 'data-user-scope' : 'data-reply-scope';
  const cds = role === 'human' ? 'UserMessage' : 'ReplyMessage';
  // claude.ai puts a heading in front of each message for a screen reader.
  // It repeats the text and adds a prefix. The fixture keeps that, because
  // a reader of the row text must skip it.
  const spoken = role === 'human' ? 'You said:' : 'Claude said:';
  return `
<div data-testid="transcript-row"
     data-perf-row="${role}"
     data-index="${index}"
     data-rs-index="${index}"
     data-perf-row-streaming="${streaming ? 'true' : 'false'}"
     data-perf-row-from-tail="${total - 1 - index}">
  <div role="article" tabindex="-1" aria-setsize="${total}" aria-posinset="${index + 1}" aria-label="message ${index + 1} of ${total}">
    <div data-mini-claude-message="_r_br_">
      <div data-transcript-row>
        <h3 data-find-omitted>${escapeHtml(spoken + ' ' + text)}</h3>
        <div ${scope}>
          <div data-cds="${cds}" data-turn-key="${escapeHtml(turnKey)}">
            <div><div>${escapeHtml(text)}</div></div>
            <div data-testid="${role === 'human' ? 'user' : 'reply'}-message-actions" data-cds="MessageActions" data-deferred>
              <span aria-hidden="true">\uE001\uE002\uE003</span>
              <button type="button" aria-label="show ${escapeHtml(spoken + ' ' + text)}">
                <svg viewBox="0 0 16 16"></svg>
              </button>
              <div data-cds-tooltip>send now Ctrl+Enter</div>
            </div>
          </div>
        </div>
        <span role="status" data-find-omitted data-testid="failed-send-status-region"></span>
      </div>
    </div>
  </div>
</div>`;
}

export interface TranscriptOptions {
  /** The conversation the message list belongs to. */
  readonly conversationId?: string;
  /**
   * How many messages the whole conversation holds.
   *
   * claude.ai draws only the last few messages of a long conversation, and
   * still reports the real total in `aria-setsize`. Pass a larger total to
   * copy that.
   */
  readonly totalMessages?: number;
  /** The position of the first drawn row in the whole conversation. */
  readonly firstIndex?: number;
}

/** The whole message list, wrapped in the containers the adapter looks for. */
export function buildTranscriptHtml(
  turns: readonly FixtureTurn[],
  options: TranscriptOptions = {},
): string {
  const firstIndex = options.firstIndex ?? 0;
  const total = options.totalMessages ?? turns.length * 2;
  const conversationId = options.conversationId ?? fakeUuid(999);
  const rows: string[] = [];
  turns.forEach((turn, i) => {
    const base = firstIndex + i * 2;
    rows.push(row(turn.id, 'human', base, total, turn.question, false));
    rows.push(row(`${turn.id}-hub-reply`, 'assistant', base + 1, total, turn.answer, turn.streaming ?? false));
  });

  return `
<div data-autoscroll-container="true" style="overflow-y: auto; height: 400px;">
  <div data-testid="chat-hub" data-conv-id="${escapeHtml(conversationId)}" data-hub-ready="true">
    <div data-testid="chat-column" data-claude-chat-column>
      <div role="feed" data-perf-region="transcript" aria-label="conversation messages">
        <div data-testid="transcript-sizer" data-rocksteady-sizer data-sizer-held>
          ${rows.join('\n')}
        </div>
      </div>
      <div data-chat-input-container>
        <div contenteditable="true" role="textbox" aria-label="write your message"></div>
      </div>
    </div>
  </div>
</div>`;
}

/** A conversation of `count` exchanges, with readable text. */
export function sampleTurns(count: number): FixtureTurn[] {
  const turns: FixtureTurn[] = [];
  for (let i = 1; i <= count; i++) {
    turns.push({
      id: fakeUuid(i),
      question: `question number ${i}: how does part ${i} work?`,
      answer: `answer number ${i}. It works in this way.`,
    });
  }
  return turns;
}
