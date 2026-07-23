import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  shouldAutoContinue,
  isLikelyTruncatedText,
  appendContinueTurn,
  getContinueLimits,
  MSG_REASONING_ONLY,
  MSG_TRUNCATED,
  isResponseTruncated,
} = require('../../src/auto-continue');

describe('auto-continue', () => {
  const prevAuto = process.env.AUTO_CONTINUE;
  const prevMax = process.env.MAX_CONTINUES;

  afterEach(() => {
    if (prevAuto === undefined) delete process.env.AUTO_CONTINUE;
    else process.env.AUTO_CONTINUE = prevAuto;
    if (prevMax === undefined) delete process.env.MAX_CONTINUES;
    else process.env.MAX_CONTINUES = prevMax;
  });

  it('reasoning_only must continue (OpenCode pain)', () => {
    const d = shouldAutoContinue(
      { reasoningContent: '用户问天气，我要调接口…', textContent: '', hasToolUse: false, messageStarted: true },
      { continueCount: 0, enabled: true, maxContinues: 10 }
    );
    expect(d.shouldContinue).toBe(true);
    expect(d.reason).toBe('reasoning_only');
    expect(d.continueMessage).toBe(MSG_REASONING_ONLY);
  });

  it('complete answer does not continue', () => {
    const d = shouldAutoContinue(
      {
        textContent: '今天天气晴，气温 25 度。',
        reasoningContent: '短思考',
        hasToolUse: false,
        messageStarted: true,
        stopReason: 'end_turn',
      },
      { continueCount: 0, enabled: true, maxContinues: 10 }
    );
    expect(d.shouldContinue).toBe(false);
    expect(d.reason).toBe('complete');
  });

  it('tool_use never continues', () => {
    const d = shouldAutoContinue(
      {
        textContent: '',
        reasoningContent: 'need tool',
        hasToolUse: true,
        messageStarted: true,
      },
      { continueCount: 0, enabled: true, maxContinues: 10 }
    );
    expect(d.shouldContinue).toBe(false);
    expect(d.reason).toBe('has_tool_use');
  });

  it('open code fence is truncated', () => {
    expect(isLikelyTruncatedText('here:\n```js\nconst x = 1')).toBe(true);
    const d = shouldAutoContinue(
      { textContent: 'here:\n```js\nconst x = 1', messageStarted: true },
      { continueCount: 0, enabled: true, maxContinues: 10 }
    );
    expect(d.shouldContinue).toBe(true);
    expect(d.reason).toBe('truncated_text');
    expect(d.continueMessage).toBe(MSG_TRUNCATED);
  });

  it('max_tokens continues', () => {
    const d = shouldAutoContinue(
      {
        textContent: 'partial answer that is reasonably long enough for threshold',
        finishReason: 'length',
        messageStarted: true,
      },
      { continueCount: 0, enabled: true, maxContinues: 10 }
    );
    expect(d.shouldContinue).toBe(true);
    expect(d.reason).toBe('max_tokens');
  });

  it('cap stops continue and marks length', () => {
    const d = shouldAutoContinue(
      { reasoningContent: 'only think', textContent: '', messageStarted: true },
      { continueCount: 10, enabled: true, maxContinues: 10 }
    );
    expect(d.shouldContinue).toBe(false);
    expect(d.reason).toBe('cap_reached');
    expect(d.finishReason).toBe('length');
  });

  it('disabled is no-op', () => {
    const d = shouldAutoContinue(
      { reasoningContent: 'only', textContent: '', messageStarted: true },
      { continueCount: 0, enabled: false, maxContinues: 10 }
    );
    expect(d.shouldContinue).toBe(false);
    expect(d.reason).toBe('disabled');
  });

  it('short incomplete after long reasoning continues', () => {
    const d = shouldAutoContinue(
      {
        reasoningContent: 'x'.repeat(500),
        textContent: 'ok', // tiny, no sentence end
        messageStarted: true,
      },
      { continueCount: 0, enabled: true, maxContinues: 10 }
    );
    expect(d.shouldContinue).toBe(true);
    expect(d.reason).toBe('short_after_reasoning');
  });

  it('short complete answer after reasoning does not continue', () => {
    const d = shouldAutoContinue(
      {
        reasoningContent: 'x'.repeat(500),
        textContent: '今天天气晴，气温 25 度。',
        messageStarted: true,
      },
      { continueCount: 0, enabled: true, maxContinues: 10 }
    );
    expect(d.shouldContinue).toBe(false);
    expect(d.reason).toBe('complete');
  });

  it('appendContinueTurn adds assistant + user', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    appendContinueTurn(
      messages,
      { textContent: 'half', reasoningContent: '' },
      MSG_TRUNCATED
    );
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({ role: 'assistant', content: 'half' });
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toBe(MSG_TRUNCATED);
  });

  it('appendContinueTurn reasoning-only uses placeholder assistant', () => {
    const messages = [];
    appendContinueTurn(
      messages,
      { textContent: '', reasoningContent: 'think hard' },
      MSG_REASONING_ONLY
    );
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toContain('reasoning');
    expect(messages[1].content).toBe(MSG_REASONING_ONLY);
  });

  it('legacy isResponseTruncated true for reasoning only', () => {
    expect(
      isResponseTruncated({
        messageStarted: true,
        textContent: '',
        reasoningContent: 'thinking',
        hasToolUse: false,
      })
    ).toBe(true);
  });

  it('getContinueLimits reads env defaults', () => {
    delete process.env.AUTO_CONTINUE;
    delete process.env.MAX_CONTINUES;
    const lim = getContinueLimits();
    expect(lim.enabled).toBe(true);
    expect(lim.maxContinues).toBe(10);
  });
});
