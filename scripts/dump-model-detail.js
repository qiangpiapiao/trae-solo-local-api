// scripts/dump-model-detail.js
// Dump 完整的 get_detail_param 响应，重点找思考深度相关字段。
// 用法: node scripts/dump-model-detail.js [model_name]
//
// 目的: 上游接口是否暴露思考深度控制 (thinking/reasoning_effort/budget)。
// 重点看 model_extra_config (明文) 和 encrypted_model_params (加密)。
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const auth = require('../src/auth');

const targetModel = process.argv[2] || null; // 不指定则 dump 全部

async function main() {
  const a = await auth.refreshTokenIfNeeded();
  const apiHost = auth.getApiHost();
  const headers = auth.buildCommonHeaders(a, auth.getDeviceIds());
  const fn = process.env.TRAE_SOLO_FUNCTION || 'solo_work_lite';

  console.log(`[dump] host=${apiHost} function=${fn} target=${targetModel || '(all)'}`);

  const resp = await fetch(`${apiHost}/api/ide/v1/get_detail_param`, {
    method: 'POST',
    headers: { ...headers, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      function: fn,
      config_names: null,
      need_prompt: true,        // 关键: 拉完整 prompt + 配置
      current_config_info: null,
      poly_prompt: true,
      mode_type: null,
      agent_type: null,
    }),
  });

  if (!resp.ok) {
    console.error(`[dump] FAILED ${resp.status}: ${await resp.text()}`);
    process.exit(1);
  }

  const data = await resp.json();

  // 保存完整原始响应
  const outDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `detail-param-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2));
  console.log(`[dump] 完整响应已保存: ${outFile} (${fs.statSync(outFile).size} bytes)`);

  // 顶层结构概览
  console.log('\n=== 顶层字段 ===');
  console.log(Object.keys(data));

  const list = data.config_info_list || [];
  console.log(`\n=== config_info_list: ${list.length} 个模型 ===`);

  // 找思考相关关键词 (明文部分)
  const THINK_KEYS = /thinking|reason|effort|budget|think|depth|深思|思考/i;
  const foundThinking = [];

  for (const cfg of list) {
    const cfgName = cfg.config_name;
    if (targetModel && cfgName !== targetModel) continue;

    const mdList = cfg.model_detail_list || [];
    console.log(`\n--- ${cfgName} (${mdList.length} detail entries) ---`);

    // cfg 层字段
    console.log('  cfg keys:', Object.keys(cfg).join(', '));

    // 检查 cfg.extra_config (明文)
    if (cfg.extra_config) {
      console.log('  cfg.extra_config:', JSON.stringify(cfg.extra_config));
      if (THINK_KEYS.test(JSON.stringify(cfg.extra_config))) {
        foundThinking.push({ model: cfgName, where: 'cfg.extra_config', val: cfg.extra_config });
      }
    }

    for (const md of mdList) {
      console.log('  md keys:', Object.keys(md).join(', '));
      console.log(`    model_name=${md.model_name} max_tokens=${md.max_tokens} max_turn=${md.max_turn} prompt_max_tokens=${md.prompt_max_tokens}`);
      if (md.encrypted_model_params) {
        console.log(`    encrypted_model_params: len=${String(md.encrypted_model_params).length} (加密, 前缀=${String(md.encrypted_model_params).slice(0,40)}...)`);
      }
      // model_extra_config (可能明文 JSON)
      if (md.model_extra_config) {
        const mecStr = typeof md.model_extra_config === 'string' ? md.model_extra_config : JSON.stringify(md.model_extra_config);
        console.log('    model_extra_config:', mecStr.slice(0, 500));
        if (THINK_KEYS.test(mecStr)) {
          foundThinking.push({ model: cfgName, where: 'md.model_extra_config', val: mecStr });
        }
      }
      // 全字段扫一遍关键词
      const allStr = JSON.stringify(md);
      const hits = (allStr.match(THINK_KEYS) || []);
      if (hits.length) {
        console.log(`    [KEYWORD HIT in model_detail]: ${[...new Set(hits)].join(', ')}`);
      }
    }
  }

  // 在整个响应里全局搜关键词 (最彻底)
  console.log('\n=== 全局关键词扫描 (整个响应) ===');
  const fullStr = JSON.stringify(data);
  const allHits = [...fullStr.matchAll(/"[a-z_]*(thinking|reason|effort|budget|depth)[a-z_]*"\s*:/gi)];
  if (allHits.length === 0) {
    console.log('  ❌ 整个响应里没有任何 thinking/reason/effort/budget/depth 字段');
  } else {
    console.log(`  ✅ 命中 ${allHits.length} 处:`);
    for (const h of allHits.slice(0, 20)) {
      console.log(`    ${h[0]}`);
    }
  }

  console.log('\n=== 结论 ===');
  if (foundThinking.length === 0 && allHits.length === 0) {
    console.log('上游 get_detail_param 响应中未发现任何思考深度控制字段。');
    console.log('→ 上游协议可能不暴露思考深度控制 (模型按服务端固定深度思考)。');
    console.log('→ 若 encrypted_model_params 加密体内藏思考开关, 需解密 AES 后才能确认。');
  } else {
    console.log('发现候选思考字段, 见上方命中详情。');
  }
}

main().catch(e => { console.error('[dump] error:', e.message); process.exit(1); });
