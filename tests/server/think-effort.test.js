import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  applyThinkEffort,
  resolveThinkEffort,
  normalizeEffort,
  getThinkEffortSupport,
  extractThinkEffortFromBody,
  stripThinkEffortMarker,
  PREFIX_MAX_ABS,
  PREFIX_MAX_SHORT,
  PREFIX_HIGH,
  PREFIX_KIMI_LOW,
} = require('../../src/think-effort');

describe('think-effort', () => {
  it('normalizes aliases', () => {
    expect(normalizeEffort('max')).toBe('max');
    expect(normalizeEffort('MAX')).toBe('max');
    expect(normalizeEffort('deep')).toBe('max');
    expect(normalizeEffort('high')).toBe('high');
    expect(normalizeEffort('medium')).toBe('high');
    expect(normalizeEffort('low')).toBe('low');
    expect(normalizeEffort('off')).toBe('off');
    expect(normalizeEffort(null)).toBe('auto');
    expect(normalizeEffort('nope')).toBe(null);
  });

  it('glm-5.2 max injects short Max, not Absolute', () => {
    const r = resolveThinkEffort('glm-5.2', 'max');
    expect(r.injected).toBe(true);
    expect(r.family).toBe('glm');
    expect(r.prefix).toBe(PREFIX_MAX_SHORT);
    expect(r.prefix).not.toContain('Absolute maximum');
  });

  it('glm-5.2 high injects High', () => {
    const r = resolveThinkEffort('glm-5.2', 'high');
    expect(r.injected).toBe(true);
    expect(r.prefix).toBe(PREFIX_HIGH);
  });

  it('glm-5.2 low is unsupported (no-op)', () => {
    const r = resolveThinkEffort('glm-5.2', 'low');
    expect(r.injected).toBe(false);
    expect(r.reason).toBe('unsupported_level_for_model');
  });

  it('DeepSeek-V4-Pro max injects Absolute long prefix', () => {
    const r = resolveThinkEffort('DeepSeek-V4-Pro', 'max');
    expect(r.injected).toBe(true);
    expect(r.family).toBe('deepseek');
    expect(r.prefix).toBe(PREFIX_MAX_ABS);
  });

  it('DeepSeek-V4-Pro high is unsupported', () => {
    const r = resolveThinkEffort('DeepSeek-V4-Pro', 'high');
    expect(r.injected).toBe(false);
  });

  it('kimi-k2.7-code supports low and max', () => {
    const low = resolveThinkEffort('kimi-k2.7-code', 'low');
    const max = resolveThinkEffort('kimi-k2.7-code', 'max');
    expect(low.injected).toBe(true);
    expect(low.prefix).toBe(PREFIX_KIMI_LOW);
    expect(max.injected).toBe(true);
    expect(max.prefix).toBe(PREFIX_MAX_ABS);
  });

  it('unsupported model is no-op', () => {
    const r = resolveThinkEffort('Doubao-Seed-2.0-Code', 'max');
    expect(r.injected).toBe(false);
    expect(r.reason).toBe('unsupported_model');
  });

  it('applyThinkEffort prepends to system and is re-entrant on model change', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ];
    const a = applyThinkEffort(messages, 'glm-5.2', 'max');
    expect(a.meta.injected).toBe(true);
    expect(messages[0].content.startsWith('<<think_effort>>')).toBe(true);
    expect(messages[0].content).toContain('Reasoning Effort: Max');
    expect(messages[0].content).toContain('You are helpful.');

    const b = applyThinkEffort(messages, 'DeepSeek-V4-Pro', 'max');
    expect(b.meta.injected).toBe(true);
    expect(messages[0].content).toContain('Absolute maximum');
    expect(messages[0].content).not.toMatch(/Reasoning Effort: Max\n/);
    expect(messages[0].content.split('<<think_effort>>').length - 1).toBe(1);
  });

  it('applyThinkEffort creates system message when missing', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    applyThinkEffort(messages, 'kimi-k2.7-code', 'low');
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('critical_constraints');
  });

  it('off strips without injecting', () => {
    const messages = [{ role: 'system', content: 'base' }];
    applyThinkEffort(messages, 'glm-5.2', 'max');
    applyThinkEffort(messages, 'glm-5.2', 'off');
    expect(messages[0].content).toBe('base');
    expect(messages[0].content).not.toContain('think_effort');
  });

  it('extractThinkEffortFromBody prefers think_effort', () => {
    expect(extractThinkEffortFromBody({ think_effort: 'max', reasoning_effort: 'low' })).toBe('max');
    expect(extractThinkEffortFromBody({ reasoning_effort: 'high' })).toBe('high');
    expect(extractThinkEffortFromBody({})).toBe(null);
  });

  it('getThinkEffortSupport lists three models', () => {
    const s = getThinkEffortSupport();
    expect(s.models['glm-5.2']).toBeTruthy();
    expect(s.models['DeepSeek-V4-Pro']).toBeTruthy();
    expect(s.models['kimi-k2.7-code']).toBeTruthy();
  });

  it('stripThinkEffortMarker removes block', () => {
    const s = '<<think_effort>>\nX\n<</think_effort>>\n\nhello';
    expect(stripThinkEffortMarker(s)).toBe('hello');
  });
});
