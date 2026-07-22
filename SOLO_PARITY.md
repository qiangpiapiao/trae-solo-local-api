# TRAE SOLO 请求对齐

目标：本地请求尽量贴近 **TRAE SOLO** 真机。

## 排队：CN vs SOLO

| 产品 | 常见 function | 热门模型排队 |
|---|---|---|
| Trae CN | `chat_v3` 通用池 | **很重**（常 1000+） |
| TRAE SOLO | `solo_work_lite` / `create_agent_task` | **较轻** |

本项目默认 `TRAE_PRODUCT=solo`，指定模型走 `solo_work_lite`，不要退回 CN 的 `chat_v3` 主路径。

## 已对齐（可用）

本仓库：https://github.com/Ttungx/trae-solo-local-api  
上游：https://github.com/ZedeX/trae-local-api  

### 认证
- 目录：`%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json`
- 解密 `iCubeAuthInfo://icube.cloudide`（tc / AES-128-CBC）

### Headers（与 SOLO 日志一致）
| Header | 来源 |
|---|---|
| `x-app-id` | 固定 app id |
| `x-device-id` | `iCubeAuthInfo://icube-dc:<id>` |
| `x-machine-id` | `telemetry.machineId` |
| `x-ide-version` | manifest `appVersion` |
| `x-ide-version-code` | 日期型 |
| `x-device-brand` / `x-os-version` | SOLO 默认，env 可覆盖 |
| `x-flow-traceparent` | 本地生成 |
| `Authorization` | `Cloud-IDE-JWT <token>` |

### 对话通道
| 模式 | 本地 | 说明 |
|---|---|---|
| `auto` | `llm_utils_chat` + `inline_chat` | 最轻 |
| 指定模型 | `llm_utils_chat` + **`solo_work_lite`** + `config_name` | 与 SOLO 同池 |
| 完整 Agent | `create_agent_task` 骨架 | 未 100% 复刻 |

实测：`solo_work_lite + glm-5.2` 正常；`chat_v3 + glm-5.2` 易大排队。

### 模型目录（重要）

`llm_utils_chat` 的 `config_name` 必须在 SOLO `get_detail_param(function=solo_work_lite)` 返回列表中。  
**不在列表**（如历史 `glm-5.1`）会立刻 `4001 param is invalid`。  
可用主力：`glm-5.2`、`glm-5-turbo`、`glm-5`、`DeepSeek-V4-Pro`、`DeepSeek-V4-Flash`、`qwen-3.7-plus`、`kimi-k*`、`Doubao-Seed-2.*` 等。  
拉表：`node scripts/dump-model-detail.js`。本地 `model-config.json` 别名可映射到上述名；排队/错误降级也会跳过 4001/4023。

### OAuth
SOLO ClientID：`en1oxy7wnw8j9n`（`product.json` → `authConfig.SOLO.stable`）

## 未完成：`create_agent_task`

真机：

```text
POST /api/agent/v3/create_agent_task
body ≈ 180–210KB
agent_type=function=solo_work_lite
```

卡点：summary template / `encrypted_prompt_set` 非 tc，需抓完整明文 body。  
步骤见 `TODO.md`。探测：`node scripts/probe-solo-create-agent.js --model glm-5.2`。

## `.env` 要点

```env
TRAE_PRODUCT=solo
TRAE_EDITION=cn
# TRAE_DATA_DIR=%APPDATA%/TRAE SOLO CN
# TRAE_SOLO_FUNCTION=solo_work_lite
# TRAE_OAUTH_CLIENT_ID=en1oxy7wnw8j9n
```
