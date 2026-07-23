# Think Effort 注入（曲线救国）

> 状态：已落地（2026-07-23）  
> 代码：`src/think-effort.js` · API 参数 `think_effort`  
> Probe：`scripts/probe-reasoning-effort.js` · `scripts/probe-reasoning-deepen.js`

## 1. 问题

SOLO `llm_utils_chat` **没有**原生 `reasoning_effort` / `enable_thinking` 字段。  
对外只认 `messages` + `function` + `config_name`。

行业上多数 reasoning 档位（gpt-oss、DeepSeek-V4、GLM-5.2）在推理侧是 **system / chat-template 前缀** 做条件化控制（训练时见过这些串）。  
本项目在网关层按模型族把固定串 **prepend 到 system 最顶部**，实现“曲线救国”。

## 2. 方法论

### 2.1 原则

1. **固定串**，放 **system 第 0 字节**（便于前缀稳定；避免动态文案破坏缓存语义）。
2. **按模型族** 选串，禁止全模型共用一套。
3. **fallback / 换模** 时按新 `config_name` **strip 旧串 + 重算**。
4. 不支持的模型或档位 → **静默 no-op**（请求仍成功）。
5. 量的是 **reasoning 长度 / 耗时**，不是答题正确率。

### 2.2 实验方法（可复现）

| 项 | 要求 |
|----|------|
| 环境 | 本地 API + 已登录 SOLO；**关** `autoFallback` / tier race |
| 钉死 | body 带 `model` + `config_name` 同为真实 SOLO 名 |
| 任务 | 固定短算法题（同一 `USER_TASK`） |
| 对照 | 同模型 `base`（无注入） vs 注入臂 |
| 重复 | **每格 ≥2 次**，报告 mean / min / max |
| 指标 | `reasoning_content` 字符数、latency、`completion_tokens` |
| 判定 | 加深：mean Δ ≥ +30% 或 +400 字，且两次同向更可信 |
| 恢复 | 测完恢复 `model-config.json` / `model-fallback.json` |

关 fallback 示例（测完务必还原）：

```js
// model-config.json → fallback.autoFallback = false
// model-fallback.json → autoFallback = false
// 热加载后 GET /v1/dashboard/fallback-config 确认
```

跑 deepen probe：

```bash
# 先关 fallback，再：
PROBE_REPEATS=2 node scripts/probe-reasoning-deepen.js
```

### 2.3 实验一：方向摸底（单次，部分作废）

- 脚本：`probe-reasoning-effort.js`
- 问题：未关 race 时结果被换模污染（Kimi 标签实际跑到 glm-5-turbo）
- 干净复跑（fallback off）要点：
  - **Kimi low**（critical_constraints）：reasoning **−87%** → 压低有效
  - **GLM high**：明显变短 → 预算控制有效
  - **DeepSeek Max 长串**：单次噪声，需 n≥2

### 2.4 实验二：加深专用（n=2，2026-07-23）

- 脚本：`probe-reasoning-deepen.js`
- 条件：`base` | `max_short` (`Reasoning Effort: Max`) | `max_abs`（Absolute maximum 长串）| `thorough`（通用加深句）
- 任务：rotated sorted array `findMin` + 短证明
- 原始数据：`output/effort-deepen-*.json`（gitignore）

**mean reasoning 字符（n=2）**

| 模型 | base | max_short | max_abs | thorough |
|------|------|-----------|---------|----------|
| glm-5.2 | 21245 | **31604 (+49%)** | 8433 (**−60%**) | **30190 (+42%)** |
| DeepSeek-V4-Pro | 4061 | 3633 (−11%) | **5681 (+40%)** | 3504 (−14%) |
| kimi-k2.7-code | 3721 | 4903 (+32% 不稳) | **7512 (+102% 极稳)** | 7685 (+107% 不稳) |

**稳定性**

| 格 | min–max | 结论 |
|----|---------|------|
| DS `max_abs` | 5025–6337 | 两次都深于 base → **可信加深** |
| Kimi `max_abs` | 7508–7516 | 几乎重合 → **最稳加深** |
| GLM `max_short` | 13109–50098 | 均值加深但方差大 |
| GLM `max_abs` | — | **有害**（短 Max 标签可用，长 Absolute 不可用） |

### 2.5 落地映射（当前代码）

| SOLO `config_name` | `think_effort` | 注入 |
|--------------------|----------------|------|
| `glm-5.2` | `high` | `Reasoning Effort: High` |
| `glm-5.2` | `max` | `Reasoning Effort: Max` |
| `DeepSeek-V4-Pro` | `max` | Absolute maximum **长串** |
| `kimi-k2.7-code` | `max` | Absolute maximum **长串** |
| `kimi-k2.7-code` | `low` | `<critical_constraints>…never draft…` |
| 其它模型 / `auto` / `off` | — | 不注入 |

标记块（便于 strip 重算）：

```text
<<think_effort>>
…prefix…
<</think_effort>>
```

## 3. API

### 3.1 参数

| 字段 | 说明 |
|------|------|
| `think_effort` | **主字段** |
| `reasoning_effort` | 别名（OpenAI 生态常见） |

取值：`off` | `auto` | `high` | `max` | `low`  
（另有别名：`deep`/`ultra`→`max`，`medium`→`high`，`none`→`off`）

- `auto` / 缺省：不注入  
- `off`：不注入（并清掉历史 marker）  
- 不支持组合：不注入，HTTP 仍 200

### 3.2 OpenAI

```bash
curl -s http://localhost:19900/v1/chat/completions \
  -H "Authorization: Bearer trae-solo-local-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
    "think_effort": "max",
    "messages": [{"role":"user","content":"prove why mid vs right"}],
    "stream": false
  }'
```

### 3.3 Anthropic

```bash
curl -s http://localhost:19900/v1/messages \
  -H "Authorization: Bearer trae-solo-local-api-key" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "DeepSeek-V4-Pro",
    "max_tokens": 2048,
    "think_effort": "max",
    "messages": [{"role":"user","content":"findMin rotated array"}]
  }'
```

### 3.4 能力查询

```http
GET /v1/think-effort
Authorization: Bearer …
```

返回支持矩阵（与 `getThinkEffortSupport()` 一致）。

### 3.5 日志

成功注入时：

```text
[think_effort] model=DeepSeek-V4-Pro family=deepseek effort=max injected=yes
```

## 4. 实现位置

| 文件 | 职责 |
|------|------|
| `src/think-effort.js` | 串表、resolve、apply/strip |
| `src/server.js` | 解析 body；OpenAI/Anthropic 在 **每次** `llmUtilsChat` 前按当前 config 重算 |
| `src/config-schema.js` | session 可选默认 `think_effort` |
| `tests/server/think-effort.test.js` | 单元测试 |

**注入顺序**：先 tool 协议等，再 think_effort **顶置**（apply 时 strip 后 prepend，保证 effort 在 system 最前）。

**Fallback**：`startOne` / race / Anthropic `processStream` 换 `config_name` 时再次 `applyThinkEffort`。

## 5. 局限与后续

- 不是官方 API 等价；测的是 **SOLO 上该 config_name** 行为。
- n=2 方差仍大（尤其 GLM）；要加硬可 `PROBE_REPEATS=3`。
- 未覆盖：`enable_thinking:false` 硬关、token budget 截断（网关无模板钩子）。
- 扩模型：先跑 deepen probe，再改 `FAMILIES` 与本文表格。

## 6. 参考

- Sebastian Raschka, *Controlling Reasoning Effort in LLMs*（训练条件化 + system 标签）
- DeepSeek-V4 encoding README：`Reasoning Effort: Absolute maximum…`
- GLM-5.2 `chat_template.jinja`：`Reasoning Effort: Max|High`
- 社区 Kimi overthink 抑制：`<critical_constraints>`
