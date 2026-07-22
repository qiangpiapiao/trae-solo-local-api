# trae-solo-local-api

把 **TRAE SOLO(Trae Work)** 包装成本地 OpenAI / Anthropic 兼容 API，供 Claude Code、Cursor、Cline 等调用 SOLO 底层模型。

- **本仓库**：https://github.com/Ttungx/trae-solo-local-api  
- **上游原项目**：https://github.com/ZedeX/trae-local-api  

本仓库是 SOLO 适配分支，不是官方上游。

### 相对上游的主要改动

| 改动 | 说明 |
|---|---|
| 数据目录 | 优先 `%APPDATA%\TRAE SOLO CN`，并用 `APPDATA`（支持重定向盘） |
| 功能池 | 指定模型走 `solo_work_lite`，避免 Trae CN 的 `chat_v3` 重排队 |
| Header | SOLO device id（`icube-dc`）、`appVersion`、`x-flow-traceparent` 等 |
| OAuth | SOLO ClientID 默认 `en1oxy7wnw8j9n` |
| 排队降级 | OpenAI `/v1/chat/completions` 也支持超阈值换模型 |
| 模型表 | 补充 SOLO 侧模型/别名与 fallback |
| 文档 | 短 README + `SOLO_PARITY.md` / `TODO.md`；去掉上游冗长进度/教程副本 |

> **排队**：Trae CN `chat_v3` 很重；SOLO `solo_work_lite` 较轻。默认按 SOLO。

未完成：完整复刻 SOLO `create_agent_task`（~200KB body）— 见 `TODO.md`。

## 快速开始

1. 安装并登录 [TRAE SOLO](https://trae.cn/)，能正常对话  
2. Node.js ≥ 18  

```bash
git clone https://github.com/Ttungx/trae-solo-local-api.git
cd trae-solo-local-api
npm install
cp .env.example .env
# 默认 TRAE_PRODUCT=solo
npm start
```

- 服务：`http://localhost:19900`
- Key：`.env` 的 `API_KEY`（示例 `trae-solo-local-api-key`）
- 数据：`%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json`

## 验证

```bash
curl -s http://localhost:19900/v1/status -H "Authorization: Bearer trae-solo-local-api-key"

curl -s http://localhost:19900/v1/chat/completions \
  -H "Authorization: Bearer trae-solo-local-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

日志应含：`function=solo_work_lite, config_name=glm-5.2`。

| 参数 | 后端 | 排队 |
|---|---|---|
| `auto` | `inline_chat` | 很轻 |
| `glm-5.2` 等 | `solo_work_lite` | 较轻 |
| `chat_v3`（CN 风格） | 通用池 | 很重，不推荐 |

## 客户端

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:19900"
$env:ANTHROPIC_API_KEY = "trae-solo-local-api-key"
claude
```

Cursor/Cline：Base URL `http://localhost:19900/v1`，Key 同上，Model `auto` / `glm-5.2`。

## 目录

```text
src/           服务与 Trae/SOLO 客户端
web/           Dashboard
scripts/       模型拉取 / SOLO probe
model-config.json
SOLO_PARITY.md  对齐细节
TODO.md         未完成项
.env.example
```

## FAQ

| 问题 | 处理 |
|---|---|
| 无 auth | 登录 SOLO 并对话；检查 storage 或设 `TRAE_DATA_DIR` |
| 指定模型慢 | 日志须为 `solo_work_lite` 不是 `chat_v3` |
| 解密失败 / 401 | 重登 SOLO 或 `TRAE_MANUAL_TOKEN` |
| `Error 4001` param invalid | `config_name` 不在 SOLO `solo_work_lite` 目录。改用目录内模型（如 `glm-5.2` / `glm-5-turbo` / `DeepSeek-V4-Pro`）。`model-config.json` 已把幽灵别名映射到有效名；排队降级也会跳过 4001/4023 |
| 排队后失败 | 阈值默认 50；降级链只含 SOLO 有效 `config_name`。改 `model-config.json` 的 `fallback` / tiers |

同步官方模型表：`node scripts/dump-model-detail.js`（结果在 `output/`，已 gitignore）。

仅供学习研究。遵守 SOLO/Trae 服务条款。
