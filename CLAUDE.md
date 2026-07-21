# CLAUDE.md — trae-solo-local-api

## 项目

TRAE SOLO → 本地 OpenAI/Anthropic API。  
本仓库：https://github.com/Ttungx/trae-solo-local-api  
上游：https://github.com/ZedeX/trae-local-api

## 怎么跑

```bash
cp .env.example .env   # TRAE_PRODUCT=solo
npm install
npm start              # http://localhost:19900
```

需本机已登录 TRAE SOLO；读 `%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json`。

## 技术栈

Node.js (Express)、node-fetch、dotenv；无打包步骤。

## 约定

- **默认产品线 SOLO**：指定模型 `function=solo_work_lite`，勿改回 `chat_v3` 作主路径（排队重）。
- 数据路径用 `APPDATA` / `TRAE_DATA_DIR`，不要写死 `homedir\AppData`。
- SOLO device id 来自 `iCubeAuthInfo://icube-dc:<id>`。
- 勿提交 `.env`、`logs/`、`captures/`、含 `encrypted_model_params` 的临时 JSON。
- 权威文档：`README.md`、`SOLO_PARITY.md`、`TODO.md`。

## 状态

- 可用：解密 + `solo_work_lite` 对话 + OpenAI 排队降级  
- 待做：完整 `create_agent_task` 对齐（`TODO.md` #1）
