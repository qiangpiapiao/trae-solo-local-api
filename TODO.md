# TODO

## 高优先级

### [ ] 完整对齐 SOLO `create_agent_task`

本地指定模型目前用 `llm_utils_chat + solo_work_lite`（排队轻、可用）。  
完整 Agent 通道需抓 SOLO 真机 `create_agent_task` body（~200KB），再补 skills/tools/history/prompt。

1. mitm / Fiddler 抓包 → `captures/`（gitignore）
2. 字段对齐后主路径切 `create_agent_task`，失败回退 `solo_work_lite`
3. 更新 `SOLO_PARITY.md`

## 中优先级

- [ ] 从 SOLO `get_detail_param` / `state.vscdb` 自动同步 `model-config.json`（剔除幽灵 config_name）
- [ ] 开机自启脚本
- [ ] Claude Code / Cursor / OpenCode 一键配置说明

## 低优先级

- [ ] 单测：SOLO 目录探测、header、model resolve
- [ ] 上游冗长文档迁 `docs/` 或删减
