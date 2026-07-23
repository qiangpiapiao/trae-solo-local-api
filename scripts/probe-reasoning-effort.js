#!/usr/bin/env node
/**
 * Short A/B probe: does system-prompt reasoning-effort injection change
 * reasoning length on SOLO models via local API?
 *
 * Families: GLM / DeepSeek / Kimi only.
 * Metric: reasoning_content char count + completion content length + latency.
 * No quality grading — length delta is the signal.
 */
'use strict';

const API = process.env.PROBE_API || 'http://localhost:19900/v1/chat/completions';
const KEY = process.env.API_KEY || 'trae-solo-local-api-key';

// Same hard-ish task for all arms — needs multi-step logic, not pure recall.
const USER_TASK =
  'A bug: sorted array nums is rotated at unknown pivot. Write binary-search ' +
  'findMin(nums) in O(log n). Then prove why the midpoint branch is correct ' +
  'for the case nums[mid] > nums[right]. Answer in English. Code + short proof only.';

const DEEPSEEK_MAX =
  'Reasoning Effort: Absolute maximum with no shortcuts permitted. You MUST be very thorough in your thinking and comprehensively decompose the problem to resolve the root cause, rigorously stress-testing your logic against all potential paths, edge cases, and adversarial scenarios. Explicitly write out your entire deliberation process, documenting every intermediate step, considered alternative, and rejected hypothesis to ensure absolutely no assumption is left unchecked.\n\n';

const GLM_MAX = 'Reasoning Effort: Max\n\n';
const GLM_HIGH = 'Reasoning Effort: High\n\n';

const KIMI_LOW =
  '<critical_constraints>\n' +
  'Reasoning Mode: Token-efficient and concise.\n' +
  'Rush through reasoning, be as concise as possible. Full send; never draft.\n' +
  'Do NOT use progressive refinement or iterative self-criticism loops.\n' +
  'You are allowed a maximum of one draft before outputting the final response.\n' +
  'BAN all moralizing, conjecture, and assumption about actions or motives. Stick to the facts.\n' +
  '</critical_constraints>\n\n';

// Compact matrix: baseline + one treatment per family (plus GLM High as 3rd for GLM only).
const ARMS = [
  { id: 'glm-base', model: 'glm-5.2', prefix: '', note: 'GLM baseline' },
  { id: 'glm-high', model: 'glm-5.2', prefix: GLM_HIGH, note: 'GLM High inject' },
  { id: 'glm-max', model: 'glm-5.2', prefix: GLM_MAX, note: 'GLM Max inject' },
  { id: 'ds-base', model: 'DeepSeek-V4-Pro', prefix: '', note: 'DeepSeek baseline' },
  { id: 'ds-max', model: 'DeepSeek-V4-Pro', prefix: DEEPSEEK_MAX, note: 'DeepSeek Max inject' },
  { id: 'kimi-base', model: 'kimi-k2.7-code', prefix: '', note: 'Kimi baseline' },
  { id: 'kimi-low', model: 'kimi-k2.7-code', prefix: KIMI_LOW, note: 'Kimi Low suppress' },
];

function buildMessages(prefix) {
  const system =
    (prefix || '') +
    'You are a careful coding assistant. Prefer correct algorithms over fluff.';
  return [
    { role: 'system', content: system },
    { role: 'user', content: USER_TASK },
  ];
}

async function oneCall(arm, attempt = 1) {
  const t0 = Date.now();
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: arm.model,
      // Pin SOLO config_name — avoid alias remaps / silent swap
      config_name: arm.model,
      stream: false,
      messages: buildMessages(arm.prefix),
      max_tokens: 4096,
    }),
  });

  const text = await res.text();
  const ms = Date.now() - t0;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      id: arm.id,
      model: arm.model,
      note: arm.note,
      ok: false,
      status: res.status,
      ms,
      attempt,
      error: text.slice(0, 300),
    };
  }

  if (!res.ok) {
    return {
      id: arm.id,
      model: arm.model,
      note: arm.note,
      ok: false,
      status: res.status,
      ms,
      attempt,
      error: JSON.stringify(json).slice(0, 300),
    };
  }

  const msg = json.choices?.[0]?.message || {};
  const content = msg.content || '';
  const reasoning =
    msg.reasoning_content ||
    msg.reasoning ||
    (typeof msg.thinking === 'string' ? msg.thinking : '') ||
    '';
  const usage = json.usage || {};
  const returnedModel = json.model || arm.model;

  // Empty body: likely queue cut / upstream silence — one retry
  if (!content && !reasoning && attempt < 2) {
    console.log(`empty, retry once...`);
    await new Promise((r) => setTimeout(r, 2000));
    return oneCall(arm, attempt + 1);
  }

  return {
    id: arm.id,
    model: arm.model,
    returnedModel,
    note: arm.note,
    ok: !!(content || reasoning),
    status: res.status,
    ms,
    attempt,
    reasoningChars: reasoning.length,
    contentChars: content.length,
    promptTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    completionTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    reasoningHead: reasoning.replace(/\s+/g, ' ').slice(0, 120),
    contentHead: content.replace(/\s+/g, ' ').slice(0, 120),
    error: !(content || reasoning) ? 'empty response after retry' : undefined,
  };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function main() {
  console.log(`API: ${API}`);
  console.log(`Task: rotated-array findMin + proof (fixed)`);
  console.log(`Arms: ${ARMS.length} (GLM×3, DeepSeek×2, Kimi×2)\n`);

  // Health
  try {
    const h = await fetch(API.replace('/chat/completions', '/status'), {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    if (!h.ok) throw new Error(`status ${h.status}`);
    console.log('Health: OK\n');
  } catch (e) {
    console.error('Health FAIL — start server first:', e.message);
    process.exit(1);
  }

  const results = [];
  // Sequential: avoid SOLO queue thrash / cross-arm interference
  for (const arm of ARMS) {
    process.stdout.write(`>> ${arm.id} (${arm.model}) ... `);
    try {
      const r = await oneCall(arm);
      results.push(r);
      if (r.ok) {
        console.log(
          `ok ret=${r.returnedModel} reason=${r.reasoningChars} content=${r.contentChars} ${r.ms}ms` +
            (r.completionTokens != null ? ` tok_out=${r.completionTokens}` : '')
        );
      } else {
        console.log(`FAIL ${r.status || ''} ${r.error || ''}`);
      }
    } catch (e) {
      console.log(`ERR ${e.message}`);
      results.push({
        id: arm.id,
        model: arm.model,
        note: arm.note,
        ok: false,
        error: e.message,
      });
    }
    // brief pause between arms
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log('\n=== TABLE ===');
  console.log(
    pad('id', 12) +
      pad('model', 18) +
      pad('retModel', 18) +
      pad('reason#', 10) +
      pad('content#', 10) +
      pad('ms', 8) +
      pad('tok_out', 8) +
      'note'
  );
  for (const r of results) {
    if (!r.ok) {
      console.log(pad(r.id, 12) + pad(r.model, 18) + 'FAIL: ' + (r.error || r.status));
      continue;
    }
    console.log(
      pad(r.id, 12) +
        pad(r.model, 18) +
        pad(r.returnedModel || r.model, 18) +
        pad(r.reasoningChars, 10) +
        pad(r.contentChars, 10) +
        pad(r.ms, 8) +
        pad(r.completionTokens ?? '-', 8) +
        r.note
    );
  }

  // Deltas vs family baseline
  console.log('\n=== DELTA vs family baseline (reasoning chars) ===');
  const byId = Object.fromEntries(results.filter((r) => r.ok).map((r) => [r.id, r]));
  const pairs = [
    ['glm-high', 'glm-base'],
    ['glm-max', 'glm-base'],
    ['ds-max', 'ds-base'],
    ['kimi-low', 'kimi-base'],
  ];
  for (const [treat, base] of pairs) {
    const a = byId[treat];
    const b = byId[base];
    if (!a || !b) {
      console.log(`${treat}: missing data`);
      continue;
    }
    const dR = a.reasoningChars - b.reasoningChars;
    const dC = a.contentChars - b.contentChars;
    const pct = b.reasoningChars ? ((dR / b.reasoningChars) * 100).toFixed(0) : 'n/a';
    console.log(
      `${treat}: Δreason=${dR} (${pct}%)  Δcontent=${dC}  base_reason=${b.reasoningChars} treat_reason=${a.reasoningChars}`
    );
  }

  console.log('\n=== VERDICT HEURISTIC ===');
  console.log('Clear signal if |Δreason| >= 30% OR |Δreason| >= 400 chars on same model.');
  console.log('Kimi Low: expect NEGATIVE Δreason if suppress works.');
  console.log('GLM Max / DS Max: expect POSITIVE Δreason if inject works.');

  // Write raw JSON next to script for later
  const outPath = require('path').join(__dirname, '..', 'output', `effort-probe-${Date.now()}.json`);
  try {
    require('fs').mkdirSync(require('path').dirname(outPath), { recursive: true });
    require('fs').writeFileSync(
      outPath,
      JSON.stringify({ task: USER_TASK, results, ts: new Date().toISOString() }, null, 2)
    );
    console.log(`\nSaved: ${outPath}`);
  } catch (e) {
    console.warn('Save failed:', e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
