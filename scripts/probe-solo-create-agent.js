// Probe / reverse-engineer SOLO create_agent_task body shapes.
// Usage:
//   node scripts/probe-solo-create-agent.js
//   node scripts/probe-solo-create-agent.js --model glm-5.2
//
// Goal: find a body that returns non-error SSE events from
//   POST /api/agent/v3/create_agent_task
//
// Current known blockers without full SOLO prompt decrypt:
//   - model config is empty  (need model_name like glm-5.2__dev + encrypted_model_params)
//   - failed to get summary template data (need decrypted prompt templates)

require('dotenv').config();
const fetch = require('node-fetch');
const auth = require('../src/auth');
const { v4: uuidv4 } = require('../src/uuid');

const modelArg = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : 'glm-5.2';

function genId() {
  return uuidv4().replace(/-/g, '').slice(0, 24);
}

async function readStream(resp, ms = 12000) {
  let buf = '';
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try { resp.body.destroy(); } catch (_) {}
      resolve();
    }, ms);
    if (!resp.body) {
      clearTimeout(t);
      resolve();
      return;
    }
    resp.body.on('data', (c) => {
      buf += c.toString();
      if (buf.length > 4000) {
        clearTimeout(t);
        try { resp.body.destroy(); } catch (_) {}
        resolve();
      }
    });
    resp.body.on('end', () => { clearTimeout(t); resolve(); });
    resp.body.on('error', () => { clearTimeout(t); resolve(); });
  });
  return buf;
}

function summarize(buf, status) {
  const msg = (buf.match(/"message":"([^"]+)"/) || [])[1] || '';
  const code = (buf.match(/"code":(\d+)/) || [])[1] || '';
  const events = [...buf.matchAll(/event:(\w+)/g)].map((m) => m[1]).slice(0, 12);
  return { status, code, msg: msg.slice(0, 200), events };
}

(async () => {
  const a = await auth.refreshTokenIfNeeded();
  const apiHost = auth.getApiHost();
  const headers = auth.buildCommonHeaders(a, auth.getDeviceIds());
  headers.Accept = 'text/event-stream';

  const detailResp = await fetch(`${apiHost}/api/ide/v1/get_detail_param`, {
    method: 'POST',
    headers: { ...headers, Accept: 'application/json' },
    body: JSON.stringify({
      function: process.env.TRAE_SOLO_FUNCTION || 'solo_work_lite',
      config_names: null,
      need_prompt: true,
      current_config_info: null,
      poly_prompt: true,
      mode_type: null,
      agent_type: null,
    }),
  });
  const detail = await detailResp.json();
  const cfg = (detail.config_info_list || []).find((x) => x.config_name === modelArg);
  if (!cfg) {
    console.error('model not found in get_detail_param:', modelArg);
    console.error('available:', (detail.config_info_list || []).map((x) => x.config_name));
    process.exit(1);
  }
  const md = cfg.model_detail_list?.[0];
  console.log('[probe] model', modelArg, 'internal', md?.model_name, 'enc_len', (md?.encrypted_model_params || '').length);

  const agentType = process.env.TRAE_SOLO_FUNCTION || 'solo_work_lite';
  const custom = {
    name: cfg.config_name,
    display_name: cfg.display_config?.display_name || cfg.config_name,
    config_name: cfg.config_name,
    model_name: md.model_name,
    encrypted_model_params: md.encrypted_model_params,
    prompt_max_tokens: md.prompt_max_tokens,
    max_tokens: md.max_tokens,
    max_turn: md.max_turn,
    extra_config: cfg.extra_config,
    function_extra_config: md.model_extra_config,
    multimodal: !!cfg.display_config?.multimodal,
    use_remote_service: true,
    is_custom_model: false,
    is_preset: true,
  };

  const variants = [
    {
      name: 'display-name only',
      patch: { model: modelArg, model_name: modelArg, config_name: modelArg },
    },
    {
      name: 'internal model_name',
      patch: { model: md.model_name, model_name: md.model_name, config_name: modelArg, custom_model: custom },
    },
    {
      name: 'internal + metadata',
      patch: {
        model: md.model_name,
        model_name: md.model_name,
        config_name: modelArg,
        custom_model: custom,
        encrypted_prompt_set: detail.metadata?.encrypted_prompt_set,
        client_config: detail.metadata?.client_config,
        config_info_list: detail.config_info_list,
      },
    },
  ];

  for (const v of variants) {
    const sid = genId();
    const tid = genId();
    const mid = genId();
    const body = {
      session_id: sid,
      task_id: tid,
      message_id: mid,
      conversation_id: sid,
      user_id: a.userId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'one word: pong' }] }],
      stream: true,
      mode_type: 1,
      agent_type: agentType,
      function: agentType,
      enable_chat_memory: false,
      workspace_folder: process.cwd(),
      workspace_path: process.cwd(),
      user_input: { id: mid, user_input: 'one word: pong', placeholder_map: '{}' },
      ide_version: auth.getIdeVersion(),
      device_id: headers['x-device-id'],
      available_tool_list: [],
      mcp_tool_list: [],
      ...v.patch,
    };
    const hh = { ...headers };
    const rid = uuidv4();
    hh['X-Request-ID'] = rid;
    hh['X-Trae-Request-ID'] = rid;
    const resp = await fetch(`${apiHost}/api/agent/v3/create_agent_task`, {
      method: 'POST',
      headers: hh,
      body: JSON.stringify(body),
    });
    const buf = await readStream(resp, 10000);
    console.log(v.name, summarize(buf, resp.status));
  }

  console.log('\n[probe] If all fail on summary template, capture a real SOLO create_agent_task body via mitmproxy/Fiddler and save as captures/create_agent_task.json');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
