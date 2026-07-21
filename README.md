# Trae Local API

把 **TRAE SOLO** 包装成本地 OpenAI / Anthropic 兼容 API，给 Claude Code、Cursor、Cline 等调用 SOLO 底层模型（GLM-5.2、DeepSeek、Qwen、Doubao…）。

> **为何用 SOLO 而不是 Trae CN？**  
> Trae CN 指定模型多走 `chat_v3` 通用池，热门模型排队很重（常见上千）。  
> TRAE SOLO 走 `solo_work_lite` 等产品池，**排队明显更轻**。本项目默认按 SOLO 对齐。

## 快速开始

1. 安装并登录 [TRAE SOLO](https://trae.cn/)，能正常对话。
2. Node.js ≥ 18。
3. 安装并配置：

```bash
git clone <this-repo> trae-local-api
cd trae-local-api
npm install
cp .env.example .env
# 默认 TRAE_PRODUCT=solo，一般不用改
npm start
```

服务：`http://localhost:19900`  
默认 Key：`.env` 里 `API_KEY`（示例 `trae-local-api-key`）

数据目录（自动探测，也可手写）：

```text
%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json
```

## 验证

```bash
curl -s http://localhost:19900/v1/status -H "Authorization: Bearer trae-local-api-key"

curl -s http://localhost:19900/v1/chat/completions \
  -H "Authorization: Bearer trae-local-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

日志应类似：`function=solo_work_lite, config_name=glm-5.2`。

| 模型参数 | 后端 | 排队 |
|---|---|---|
| `auto` | `inline_chat` | 很轻 |
| `glm-5.2` 等 | `solo_work_lite`（SOLO） | 较轻 |
| 旧路径 `chat_v3`（Trae CN 风格） | 通用池 | **很重，不推荐** |

## 客户端

**Claude Code (PowerShell)**

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:19900"
$env:ANTHROPIC_API_KEY = "trae-local-api-key"
claude
```

**Cursor / Cline**：Base URL `http://localhost:19900/v1`，Key 同上，Model `auto` 或 `glm-5.2`。

**Python**

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:19900/v1", api_key="trae-local-api-key")
print(client.chat.completions.create(
    model="glm-5.2",
    messages=[{"role": "user", "content": "hi"}],
).choices[0].message.content)
```

## 功能摘要

- OpenAI `/v1/chat/completions` + Anthropic `/v1/messages`
- 自动读 SOLO 本地 JWT，CN/SOLO `tc` 解密，token 刷新
- 模型分档 + 排队降级；多模态自动切模型
- Dashboard：`http://localhost:19900/`

更多对齐细节与未完成项：[`SOLO_PARITY.md`](./SOLO_PARITY.md)、[`TODO.md`](./TODO.md)。  
环境变量模板：[`.env.example`](./.env.example)。

## 常见问题

| 问题 | 处理 |
|---|---|
| `No readable auth info found` | 先登录 SOLO 并对话一次；检查 `%APPDATA%\TRAE SOLO CN\...storage.json`，或设 `TRAE_DATA_DIR` |
| 指定模型仍很慢/像排队 | 确认日志是 `solo_work_lite` 不是 `chat_v3`；`TRAE_PRODUCT=solo` |
| 解密失败 / 401 | 重开 SOLO 刷新登录；或 `.env` 设 `TRAE_MANUAL_TOKEN` |
| token 过期 | 服务会尝试 refresh；失败则重登 SOLO 后重启本服务 |

## 许可证

仅供学习研究。遵守 Trae / SOLO 服务条款。
