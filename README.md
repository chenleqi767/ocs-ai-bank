# OCS 本地 AI 题库（ai-bank）

把 [OCS 网课助手](https://docs.ocsjs.com/docs/other/api) 的 `AnswererWrapper` 题库协议，接到**任意 OpenAI 兼容后端**的本地中间服务。
默认后端是 OFM（Our Free Model）的免费轻量模型；OFM 不可用时，**不写代码**即可切到 Ollama / vLLM / 真 OpenAI / DSH 内嵌 OFM。

- 纯 Node.js 内置模块，**零第三方依赖**，无需 `npm install`
- 自带 Web 控制台（Vue 3 + Element Plus，本地内置，不联网）
- 网页与 OCS **共用同一份服务端答题日志**，实时同步

---

## 一、快速开始

### 1. 启动上游模型后端（OFM）

默认走 OFM standalone，先把它跑起来（端口以你的实际为准，本项目当前为 `18901`）：

```powershell
# 一键启动（官方）（推荐）
npm run start:standalone
# 高级用法
node <ofm 仓库>/packages/standalone/cli.js --port 18901 --data-dir <ofm-data>
```

> 如果你用的是 DSH 桌面端内嵌的 OFM 插件，它同样提供 OpenAI 兼容端点，跳过这一步，直接看[「切换后端」](#切换后端只改-configjson)。

### 2. 启动 ai-bank

```powershell
cd ai-bank
node src/server.js
```

看到监听信息即启动成功，默认地址 **http://127.0.0.1:8787/** 。

启动时会自动完成三件事：生成/读取 token、重建 OCS 配置、探测可用模型列表。

### 3. 打开控制台验证

浏览器打开 **http://127.0.0.1:8787/** ，在「② 测试答题」里选题型、填题目和选项，点**发送**。
答案、命中的模型、是否缓存命中会立刻出现在下方和右侧「⑤ 答题日志」表格里。

### 4. 接入 OCS

1. 控制台「③ 接入 OCS」卡片里点**复制 OCS 配置**（或直接用 `ocs/answerer-config.json` 的内容）；
2. 把整段填进 OCS 的 `AnswererWrapper` 题库配置；
3. 点 OCS 里的**连接测试**（本服务用 `GET /search` 响应，返回 200 即通过）。

若 OCS 报跨域：在脚本元信息加 `@connect 127.0.0.1`，或启用"全域名通用版本"。本服务已返回 `access-control-allow-origin: *`。

---

## 二、技术架构

### 1. 整体定位与请求流向

```
┌──────────────┐  POST /search   ┌──────────────┐  /v1/chat/completions  ┌──────────────┐
│ OCS 浏览器脚本 │ ─────────────▶ │   ai-bank    │ ────────────────────▶ │  模型后端     │
│ AnswererWrap. │ ◀───────────── │  (中间层)     │ ◀──────────────────── │ OFM/DSH/其他  │
└──────────────┘ {question,ans}  └──────────────┘  {choices[0].message}  └──────────────┘
                     :8787            :8787              :18901(OFM)
                                  ┌──────────────┐
                                  │ Web 控制台    │ 轮询 /api/logs（1.5s）
                                  └──────────────┘
```

一次答题的完整链路：

1. **鉴权**：校验 `Authorization: Bearer <token>` 或 body 里的 `token`，不匹配返回 401；
2. **归一化**：OCS 传来的 `options` 可能是 `"A. 北京\nB. 上海"` 字符串，也可能是数组，统一清洗成数组；
3. **构造提示词**：按题型（单选/多选/判断/填空）生成 system + user messages，附加你的全局提示词；
4. **选路**：按当前全局模型（或 `auto` 的候选列表）依次尝试，失败自动换下一个；
5. **解析**：从模型回复里抽出规范答案，**多选用 `#` 连接**（OCS 约定）；
6. **缓存**：相同（模型+题型+题目+选项）命中则直接复用，并标记 `cached`；
7. **落日志**：无论是否命中缓存，都写入共享日志与本次运行的 `.jsonl` 文件。

### 2. 分层结构

| 层 | 文件 | 职责 |
|---|---|---|
| **接入层** | `src/server.js` | HTTP 服务、CORS、`/search`、`/api/*`、静态页、答题日志、缓存 |
| **提示词层** | `src/prompt.js` | 按 单/多/判断/填空 构造 messages，附加全局提示词 |
| **解析层** | `src/parse.js` | 抽答案；多选 `#` 连接、判断归一化、填空截取 |
| **后端层** | `src/providers/*` | 抽象基类 + 具体实现（可插拔） |
| **配置层** | `src/config.js` / `config.json` | 配置加载与持久化（浅合并默认值） |
| **前端** | `public/index.html`、`public/app.js` | Web 控制台（Vue 3 + Element Plus） |
| **OCS 侧** | `ocs/answerer-config.json` | 直接填进 OCS 的题库配置片段 |

### 3. 可插拔后端（核心设计）

`src/providers/base.js` 定义抽象类 `ModelProvider`，只需实现两个方法：

```js
async listModels()   // 返回可用模型 id 列表
async complete({model, messages, temperature})  // 单次补全
```

工厂 `src/providers/index.js` 按 `config.provider.type` 装配：

- **`ofm`**（默认）：继承 OpenAI 协议，额外做两件便利事——① 没配 `apiKey` 时自动从 `<dataDir>/settings.json` 读 `forwardKey`；② 默认 `modelsFilter: "flash"` 偏向轻量低速率模型。
- **`dsh`**（已预留）：DSH 桌面端内嵌 OFM 插件，同样是 OpenAI 兼容端点，按 `openai` 协议接入，**代码零改动**。
- **`openai`**：任意 OpenAI 兼容后端（Ollama / vLLM / LM Studio / 真 OpenAI）。

**故障转移**：`resolveModel()` 返回按 `modelsFilter` 排序的候选列表，`complete()` 逐个尝试——某免费通道抖动（实测 OFM 偶有 `Endpoint unavailable`）自动换下一个；全部失败才返回兜底 `"未知"`，不崩服务。

### 4. 日志设计

- 服务端单例 `logStore`，**OCS 请求与网页请求共用同一份**；
- 前端每 1.5s 拉 `GET /api/logs` 增量 upsert，实现"实时同步"；
- 每次启动生成一个独立日志文件 `logs/run-<时间戳>-pid<PID>.jsonl`（每行一条 JSON），可在控制台点「下载本运行日志」获取。

### 5. 前端要点

- Vue 3 + Element Plus **全部本地内置**（`public/vendor/`），不依赖外网 CDN，断网可用；
- 明暗主题自动适配：同时引入 `element-plus.css` 与 `element-plus.dark.css`，按系统偏好或右上开关切换 `html.dark`；
- **踩坑提醒**：本项目用 DOM 内模板，`<el-option>` / `<el-input>` 等自定义标签**不能写成自闭合** `<el-option ... />`，否则浏览器会把它当未闭合标签吞掉后续兄弟节点（表现为"下拉只有一个选项""按钮消失"），必须写成 `<el-option ...></el-option>`。

---

## 三、高级设置

### 1. 配置文件 `config.json`

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "searchUrl": "http://127.0.0.1:8787/search",
  "token": "<首次启动自动生成，可手动重置>",
  "systemPrompt": "你是网课答题助手，请优先参考常见教材与题库的权威答案。",
  "provider": {
    "type": "ofm",
    "baseUrl": "http://127.0.0.1:18901/v1",
    "apiKey": "",
    "model": "auto",
    "modelsFilter": "flash",
    "temperature": 0,
    "maxTokens": 512,
    "dataDir": ""
  }
}
```

| 字段 | 说明 |
|---|---|
| `host` / `port` | 监听地址与端口，改后重启生效 |
| `searchUrl` | OCS 配置里展示的接口地址 |
| `token` | 鉴权令牌。首次启动自动生成；**只能手动重置**（控制台「重置 token」或 `POST /api/token/reset`），不会自动变更 |
| `systemPrompt` | 全局提示词，追加在 prompt 末尾（最高优先级），对所有题型与 OCS 请求生效 |
| `provider.type` | `ofm` / `dsh` / `openai` |
| `provider.baseUrl` | OpenAI 兼容端点，结尾的 `/` 会自动去掉 |
| `provider.apiKey` | 留空时 OFM 会自动读 `settings.json` 的 `forwardKey` |
| `provider.model` | 具体模型 id，或 `"auto"`（在候选间故障转移） |
| `provider.modelsFilter` | 模型名过滤正则（如 `flash`），命中者优先作为推荐模型 |
| `provider.temperature` | 默认 0，保证答案稳定 |
| `provider.maxTokens` | 单次回复上限 |
| `provider.dataDir` | OFM 数据目录，用于自动读 Key |

改完 `config.json` **重启**即可；网页上改模型/地址/提示词会即时写入并重建连接，无需重启。

### 2. 切换后端（只改 `config.json`）

**DSH 桌面端内嵌 OFM：**

```json
"provider": {
  "type": "dsh",
  "baseUrl": "http://127.0.0.1:<DSH_OFM_PORT>/v1",
  "apiKey": "<DSH_OFM_KEY>",
  "model": "",
  "modelsFilter": "flash"
}
```

端口与 Key 在 DSH 的 OFM 插件"API 接入"页查看，或翻数据目录的 `settings.json`（`forwardKey` 即 Key）。
验证：`curl http://127.0.0.1:<PORT>/v1/models -H "Authorization: Bearer <KEY>"` 能返回模型列表即通。

**任意 OpenAI 兼容后端（Ollama 等）：**

```json
"provider": {
  "type": "openai",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "apiKey": "ollama",
  "model": "qwen2.5"
}
```

### 3. 控制台功能速查

| 卡片 | 作用 |
|---|---|
| ① 选择模型 | 下拉列出**全部**模型；★ 为推荐轻量模型；选「自动」走故障转移。选择写入 `config.json` 并对 OCS 请求即时生效 |
| ② 测试答题 | 四种题型；选项每行一个；结果含答案、模型、是否缓存/兜底 |
| ②-1 全局提示词 | 保存/重置 `systemPrompt` |
| ③ 接入 OCS | 展示 token、一键复制 OCS 配置、重新生成配置、重置 token |
| ④ 上游 API 地址 | 改端点/Key 并保存；「清除缓存」清空内存模型缓存、答题缓存与 OFM 本地缓存文件 |
| ⑤ 答题日志 | 时间/题型/题目/原始选项/模型/模型返回/结果；可清空、可下载本次运行日志 |

### 4. 缓存说明

- **答题缓存**（内存）：键 = 模型 + 题型 + 题目 + 选项。命中直接返回并标记 `· 缓存`，但**同样写入日志**；
- 兜底/未知结果不写入缓存，避免污染；
- 修改模型、题目、选项任一都会产生新键；
- 「清除缓存」会一并清空它，以及模型探测缓存和 OFM 的 `catalog/availability/stats` 缓存文件。

### 5. HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/search` | 答题。body: `{title, type, options, token}`，或带 `Authorization: Bearer <token>`；返回 `{question, answer, model, cached, fallback}` |
| GET | `/search` | OCS 连接测试，返回 200 + 在线信息 |
| GET | `/health` | 健康检查：上游、provider、模型数、当前模型 |
| GET | `/api/config` | 当前配置摘要 |
| POST | `/api/config` | 改 `model` / `baseUrl` / `apiKey` / `systemPrompt`，持久化并即时生效 |
| GET | `/api/models` | 全部模型、推荐模型、过滤器、当前选中 |
| POST | `/api/models/refresh` | 强制重新探测模型列表 |
| GET | `/api/ocs-config` | 获取 OCS 配置（含当前 token） |
| POST | `/api/token/reset` | 重置 token |
| GET | `/api/logs` | 答题日志（时间倒序） |
| DELETE | `/api/logs` | 清空日志 |
| GET | `/api/logs/file` | 本次运行日志文件信息 |
| POST | `/api/cache/clear` | 清除各类缓存 |
| GET | `/`、`/app` | Web 控制台 |

`type` 取值：`single`（单选）/ `multiple`（多选）/ `judgement`（判断）/ `completion`（填空）。

### 6. 常见问题

- **答案总是「未知」**：上游模型没吐有效内容。先看日志的「模型返回」列；可换具体模型或放宽 `modelsFilter`（去掉 `flash` 限制）试试。
- **OCS 报 401**：token 不一致。在控制台点「重置 token」后**重新复制配置**填进 OCS。
- **OCS 报跨域**：脚本元信息加 `@connect 127.0.0.1`，或启用"全域名通用版本"。
- **模型列表为空**：上游端点不可达。检查 `baseUrl` 端口与 OFM 是否已启动，用 `/health` 看 `upstream`。
- **下拉只有一个选项 / 按钮不显示**：改了模板的话，检查自定义标签是否误写成自闭合（见[前端要点](#5-前端要点)），并硬刷新浏览器（Ctrl/Cmd+Shift+R）。

---

## 目录

```
ai-bank/
├── config.json               # 后端/端口/token/提示词配置
├── ocs/answerer-config.json  # OCS 端题库配置片段
├── logs/                     # 每次运行一个 .jsonl 日志文件
├── public/
│   ├── index.html            # Web 控制台（DOM 内模板）
│   ├── app.js                # 控制台逻辑
│   └── vendor/               # 本地内置 vue / element-plus / 暗色变量 / 中文包
└── src/
    ├── server.js             # HTTP + CORS + /search + /api/* + 日志 + 缓存
    ├── prompt.js             # 按题型构造 messages
    ├── parse.js              # 抽取并规整答案
    ├── cache.js              # 内存缓存工具
    ├── config.js             # 配置读写
    └── providers/
        ├── base.js           # 抽象基类 ModelProvider
        ├── openai.js         # 通用 OpenAI 兼容后端
        ├── ofm.js            # OFM standalone（自动读 Key / 偏好 flash）
        └── index.js          # createProvider 工厂
```

## 扩展新后端

要接"非 OpenAI 协议"的插件：新建 `src/providers/xxx.js` 继承 `ModelProvider` 实现 `listModels()` 与 `complete()`，
在 `src/providers/index.js` 加一个 `case`，上层 `server/prompt/parse` 完全不用动。
