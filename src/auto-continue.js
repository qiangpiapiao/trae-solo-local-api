'use strict';

/**
 * Unified auto-continue for OpenAI + Anthropic paths.
 *
 * First principle: a turn is NOT complete if the model only "thought"
 * and produced neither user-visible text nor a tool call. Upstream SOLO
 * often ends the stream after reasoning; clients (OpenCode) then see a
 * finished request with no answer. We re-prompt until real output or cap.
 */

const DEFAULT_MAX_CONTINUES = 10;
const DEFAULT_TEXT_THRESHOLD = 200;
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;

const MSG_REASONING_ONLY =
  'Your previous response contained only thinking/reasoning with no actual output. ' +
  'Please provide your actual response now — either the final answer text or a tool call. ' +
  'Do not stop after thinking.';

const MSG_TRUNCATED = '请继续输出，从你中断的地方继续。不要重复已输出内容，直接接着写。';

const MSG_MAX_TOKENS =
  'Your previous response was cut off (max tokens). Continue exactly from where you stopped. Do not restart.';

function parseBool(v, defaultTrue) {
  if (v === undefined || v === null || v === '') return defaultTrue;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
  if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
  return defaultTrue;
}

function getContinueLimits(overrides = {}) {
  const envEnabled = parseBool(process.env.AUTO_CONTINUE, true);
  const envMax = parseInt(process.env.MAX_CONTINUES || String(DEFAULT_MAX_CONTINUES), 10);
  const enabled =
    overrides.enabled !== undefined ? !!overrides.enabled : envEnabled;
  let max =
    overrides.maxContinues != null
      ? parseInt(overrides.maxContinues, 10)
      : envMax;
  if (!Number.isFinite(max) || max < 0) max = DEFAULT_MAX_CONTINUES;
  return { enabled, maxContinues: max };
}

function getTruncationThresholds(settings = {}) {
  return {
    textThreshold: parseInt(
      process.env.TRUNCATION_TEXT_THRESHOLD ||
        settings.truncationTextThreshold ||
        String(DEFAULT_TEXT_THRESHOLD),
      10
    ),
    similarityThreshold: parseFloat(
      process.env.TRUNCATION_SIMILARITY_THRESHOLD ||
        settings.truncationSimilarityThreshold ||
        String(DEFAULT_SIMILARITY_THRESHOLD)
    ),
  };
}

/**
 * Heuristic: visible text looks mid-cut.
 * @param {string} text
 */
function isLikelyTruncatedText(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;

  const codeBlockOpens = (t.match(/```/g) || []).length;
  if (codeBlockOpens % 2 !== 0) return true;

  const last100 = t.slice(-100).trim();
  const openBrackets = (last100.match(/[\[{(]/g) || []).length;
  const closeBrackets = (last100.match(/[\]})]/g) || []).length;
  if (openBrackets > closeBrackets + 2) return true;

  const truncatedEndings = [
    /,\s*$/,
    /\|\s*$/,
    /\.\.\.\s*$/,
    /\\\s*$/,
    /\/\/\s*$/,
    /#\s*$/,
    /-\s*$/,
    /:\s*$/,
    /(?:^|\n)\s*(?:function|const|let|var|class|if|for|while|return|import|export|def|async)\s*$/i,
  ];
  for (const pattern of truncatedEndings) {
    if (pattern.test(last100)) return true;
  }
  return false;
}

/**
 * Normalize turn state from either path.
 * @param {object} raw
 * @returns {{
 *   text: string,
 *   reasoning: string,
 *   hasToolUse: boolean,
 *   finishReason: string|null,
 *   messageStarted: boolean
 * }}
 */
function normalizeTurnState(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      text: '',
      reasoning: '',
      hasToolUse: false,
      finishReason: null,
      messageStarted: false,
    };
  }
  const text = String(
    raw.text ?? raw.textContent ?? raw.fullContent ?? raw.content ?? ''
  );
  const reasoning = String(
    raw.reasoning ??
      raw.reasoningContent ??
      raw.fullReasoning ??
      raw.reasoning_content ??
      ''
  );
  const tools = raw.toolCalls || raw.tool_calls || [];
  const hasToolUse =
    !!raw.hasToolUse ||
    (Array.isArray(tools) && tools.length > 0) ||
    raw.finishReason === 'tool_calls' ||
    raw.stopReason === 'tool_use';
  const finishReason =
    raw.finishReason ||
    raw.stopReason ||
    raw.finish_reason ||
    null;
  const messageStarted =
    raw.messageStarted !== undefined
      ? !!raw.messageStarted
      : !!(text || reasoning || hasToolUse);
  return { text, reasoning, hasToolUse, finishReason, messageStarted };
}

function isMaxTokensReason(finishReason) {
  if (!finishReason) return false;
  const r = String(finishReason).toLowerCase();
  return r === 'max_tokens' || r === 'length';
}

/**
 * Decide whether to auto-continue after one model turn.
 *
 * @param {object} rawState - turn output (OpenAI or Anthropic shaped)
 * @param {object} [opts]
 * @param {number} [opts.continueCount=0]
 * @param {string|null} [opts.lastShortText]
 * @param {boolean} [opts.enabled]
 * @param {number} [opts.maxContinues]
 * @param {object} [opts.settings] - model-config truncation settings
 * @returns {{
 *   shouldContinue: boolean,
 *   reason: string,
 *   continueMessage: string|null,
 *   finishReason: string|null,
 *   isShortResponse: boolean,
 *   similarityStop: boolean
 * }}
 */
function shouldAutoContinue(rawState, opts = {}) {
  const limits = getContinueLimits({
    enabled: opts.enabled,
    maxContinues: opts.maxContinues,
  });
  const { textThreshold, similarityThreshold } = getTruncationThresholds(
    opts.settings || {}
  );
  const continueCount = opts.continueCount || 0;
  const lastShortText = opts.lastShortText || null;
  const state = normalizeTurnState(rawState);

  if (!limits.enabled) {
    return {
      shouldContinue: false,
      reason: 'disabled',
      continueMessage: null,
      finishReason: null,
      isShortResponse: false,
      similarityStop: false,
    };
  }

  if (!state.messageStarted && !state.text && !state.reasoning && !state.hasToolUse) {
    return {
      shouldContinue: false,
      reason: 'no_output',
      continueMessage: null,
      finishReason: null,
      isShortResponse: false,
      similarityStop: false,
    };
  }

  // Tool calls: client must run tools — never auto-continue over them
  if (state.hasToolUse) {
    return {
      shouldContinue: false,
      reason: 'has_tool_use',
      continueMessage: null,
      finishReason: null,
      isShortResponse: false,
      similarityStop: false,
    };
  }

  if (continueCount >= limits.maxContinues) {
    return {
      shouldContinue: false,
      reason: 'cap_reached',
      continueMessage: null,
      finishReason: 'length',
      isShortResponse: false,
      similarityStop: false,
    };
  }

  const text = (state.text || '').trim();
  const reasoning = state.reasoning || '';
  const isShortResponse = text.length > 0 && text.length < textThreshold;

  // Anti-loop: same short answer twice
  if (isShortResponse && lastShortText && text.length > 0) {
    const overlap = Math.min(lastShortText.length, text.length);
    let sameChars = 0;
    for (let i = 0; i < overlap; i++) {
      if (lastShortText[i] === text[i]) sameChars++;
    }
    const similarity = overlap > 0 ? sameChars / overlap : 0;
    if (similarity > similarityThreshold) {
      return {
        shouldContinue: false,
        reason: 'short_repeat',
        continueMessage: null,
        finishReason: null,
        isShortResponse: true,
        similarityStop: true,
      };
    }
  }

  // Core case: thinking only — OpenCode pain
  if (!text && reasoning.length > 0) {
    return {
      shouldContinue: true,
      reason: 'reasoning_only',
      continueMessage: MSG_REASONING_ONLY,
      finishReason: null,
      isShortResponse: true,
      similarityStop: false,
    };
  }

  // Long think + tiny/incomplete text (not every short answer — "今天天气晴。" is fine)
  if (
    !state.hasToolUse &&
    reasoning.length >= textThreshold &&
    text.length > 0 &&
    text.length < textThreshold
  ) {
    const endsClean = /[。.!？?…）」』】>]$/.test(text);
    const tiny = text.length < 40;
    if (isLikelyTruncatedText(text) || (tiny && !endsClean)) {
      return {
        shouldContinue: true,
        reason: 'short_after_reasoning',
        continueMessage: MSG_TRUNCATED,
        finishReason: null,
        isShortResponse: true,
        similarityStop: false,
      };
    }
  }

  if (isMaxTokensReason(state.finishReason)) {
    return {
      shouldContinue: true,
      reason: 'max_tokens',
      continueMessage: MSG_MAX_TOKENS,
      finishReason: null,
      isShortResponse: false,
      similarityStop: false,
    };
  }

  if (text && isLikelyTruncatedText(text)) {
    return {
      shouldContinue: true,
      reason: 'truncated_text',
      continueMessage: MSG_TRUNCATED,
      finishReason: null,
      isShortResponse: isShortResponse,
      similarityStop: false,
    };
  }

  return {
    shouldContinue: false,
    reason: 'complete',
    continueMessage: null,
    finishReason: null,
    isShortResponse: false,
    similarityStop: false,
  };
}

/**
 * Build assistant message content for history when re-prompting.
 * Prefer visible text; if empty keep a short note so model sees context.
 */
function buildAssistantHistoryContent(rawState) {
  const state = normalizeTurnState(rawState);
  if (state.text && state.text.trim()) return state.text;
  if (state.reasoning && state.reasoning.trim()) {
    // Do not dump full thinking (can be huge); signal incomplete turn
    return '[Previous turn ended after reasoning with no user-visible answer.]';
  }
  return '';
}

/**
 * Append assistant + continue user messages onto a mutable messages array.
 * Returns whether anything was appended.
 */
function appendContinueTurn(messages, rawState, continueMessage) {
  if (!Array.isArray(messages) || !continueMessage) return false;
  const assistantContent = buildAssistantHistoryContent(rawState);
  if (assistantContent) {
    messages.push({ role: 'assistant', content: assistantContent });
  }
  messages.push({ role: 'user', content: continueMessage });
  return true;
}

/** Legacy name used by Anthropic path */
function isResponseTruncated(state) {
  const d = shouldAutoContinue(state, { continueCount: 0, enabled: true, maxContinues: 99 });
  return d.shouldContinue && (d.reason === 'reasoning_only' || d.reason === 'short_after_reasoning' ||
    d.reason === 'truncated_text' || d.reason === 'max_tokens');
}

module.exports = {
  DEFAULT_MAX_CONTINUES,
  MSG_REASONING_ONLY,
  MSG_TRUNCATED,
  MSG_MAX_TOKENS,
  getContinueLimits,
  getTruncationThresholds,
  isLikelyTruncatedText,
  normalizeTurnState,
  shouldAutoContinue,
  buildAssistantHistoryContent,
  appendContinueTurn,
  isResponseTruncated,
};
