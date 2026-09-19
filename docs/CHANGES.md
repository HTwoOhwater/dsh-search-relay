# 相对 DSH 0.1.2-rc.1 自带的版本，本仓库做了以下改动。

## 1. host 插件：`@deepseek-ai/dsh-web-search-deepseek`（relay 模式）

文件：`payload/dsh-web-search-deepseek/lib/index.js`

### 为什么改

上游插件依赖 Anthropic Messages API 的**服务端**搜索工具 `web_search_20250305`：
模型在服务端完成搜索，响应里带回 `web_search_tool_result` 块，插件把它映射成
`ctx.web.search()` 的 sources。

但经过 LiteLLM 之类的中继访问第三方模型时，中继**不执行**服务端搜索。模型只会返回：

```
content: [ { type: "tool_use", name: "web_search", input: { query: "..." } } ]
```

上游插件看到响应里没有 `web_search_tool_result` 块，直接抛
`WEB_PROVIDER_ERROR: DeepSeek returned no web_search_tool_result blocks...`，
于是 DSH 的 web_search 工具完全不可用。

### 改成什么

`search()` 在拿到响应后按顺序判断：

1. 响应里有 `web_search_tool_result` 块 → **原生路径**，走原来的 `mapAnthropicResponse()`，
   行为与上游完全一致（将来接上真正支持原生搜索的端点时自动走这条）。
2. 响应里有 `tool_use` 且 `name === "web_search"` → **relay 路径**，由插件自己执行搜索。
3. 两者都没有 → 仍然抛错（不做"从正文里猜结果"的兜底，避免幻觉）。

relay 路径的实现：

```
relaySearch(toolUses, options, signal)
  ├─ 收集所有 tool_use 里的 input.query，去重，数量受 options.maxUses 限制
  ├─ 每个 query 调 executeWebSearch(query, signal)
  │    ├─ fetchSearchText(cn.bing.com/search?q=...&format=rss)   RSS 优先
  │    ├─ 失败则 fetchSearchText(www.bing.com/search?q=...&format=rss)
  │    └─ 再失败则抓 HTML，用 parseBingHtml 解析 <li class="b_algo"> 块
  ├─ parseBingRss 解析 <item> 的 title / link / description / pubDate
  ├─ 跳过 bing.com/ck/ 跳转链接，按 URL 去重
  └─ 每个 query 最多 RELAY_RESULTS_PER_QUERY = 10 条
```

新增的辅助函数：`htmlDecode`、`stripTags`、`parseBingRss`、`parseBingHtml`、
`fetchSearchText`、`executeWebSearch`、`relaySearch`。
新增常量：`SEARCH_USER_AGENT`、`BING_SEARCH_URLS`、`RELAY_RESULTS_PER_QUERY`。

搜索结果**直接**作为 sources 返回，不做第二次模型调用（省一次往返，也避免模型编造）。

### 设计取舍

- **不做二次模型总结**：多一次 LLM 往返意味着更高延迟和新的幻觉来源；DSH 的
  web_search 工具本身就会把 sources 交给主模型，主模型自己会读。
- **不做正文猜结果的兜底**：模型有时会用纯文本回答而不发 tool_use。这种情况下
  宁可报错，也不把模型正文当成搜索结果（那是幻觉的温床）。
- **只接 Bing**：RSS 接口稳定、结构干净、无需 key。Google/Brave 需要 key 或被墙。

## 2. 客户端：`@deepseek-ai/dsh-client-ui-settings-plugins`（「模型」字段）

host 侧的 settings schema 一直支持 `model` 键，但设置页的 Web search 卡片是**硬编码**的，
只渲染 API key / Endpoint / Max searches 三个控件，所以 GUI 里看不到、也改不了模型。

改动（`payload/client-ui/patch-client.mjs` 以锚点方式插入，共 5 处 + 2 个类型文件）：

| 位置 | 改动 |
| --- | --- |
| 渲染层 | 在 `plugin-config-web-search-max-uses` 的 `ValueField` 之前插入 `plugin-config-web-search-model` 的 `ValueField` |
| 控制器 | `CardForm` 字段列表：`[textField("baseURL"), numberField("maxUses")]` → 中间插入 `textField("model")` |
| 控制器 | `projection()` 增加 `model: this.form.field("model")` |
| 文案 | en / zh 各加 `webSearchModel` + `webSearchModelHint` |
| 类型 | `web-search-card-controller.d.ts` 增加 `WebSearchSettings.model?` 与 `WebSearchCardState.model` |
| 类型 | `locales.d.ts` 的 `PluginsSettingsLocaleKey` 联合类型增加两个 key |

### 为什么用锚点补丁而不是整包覆盖

`lib/client.js` 是客户端编译产物（约 1800 行），和 DSH 版本强耦合。整包覆盖在版本
不一致时会把客户端静默降级。锚点补丁只做「在已知锚点后插入」：

- 幂等：重复执行不会重复插入；
- 缩进自适应：从目标文件现读缩进，tab / 空格风格都能用；
- 语种自适应：按 locale 块里是否含中日韩文字自动选 en / zh 文案；
- 失败明确：锚点找不到就报错并**保持文件不动**，不会写坏客户端。

`payload/client-ui/lib/client.js` 是打好的完整文件，仅作为 `--overlay-client` 兜底
（只在目标 DSH 版本与本仓库完全一致时使用）。

## 3. 验证记录

- **补丁正确性**：把当前机器上已验证可用的文件「反向还原」成上游原版，再用
  `patch-client.mjs` 重新打一遍，与原件 **SHA256 逐字节一致**；重复执行第二次
  不产生任何改动（幂等）。
- **安装器端到端**：在假 DSH 安装目录 + 假 `$HOME` 下跑完 16 项检查，全部通过：
  `--check` 不写入任何文件、host 文件被正确覆盖且 `package.json` 保留、
  客户端补丁结果与已知可用版本一致、`settings.yaml` 追加且不破坏原有内容、
  密钥写入、备份生成、重复安装幂等、`--restore` 与 `--restore --from` 都能还原。
- **凭据写入**：7 种场景 13 项检查，每一份写出的 `.credentials.yaml` 都用
  `@deepseek-ai/dsh-credentials-local` 的**真实解析器** `parseCredentialsDocument()`
  加载验证：新建、插入 refs 段、已有其他 refs、替换同名值、旧版扁平布局（拒绝改写）、
  值损坏（修复）、内联 `refs: {}`（拒绝改写）。
- 补丁后的 `lib/client.js` 通过 `node --check`（ESM）语法检查。

### 测试抓出来的两个真问题（已修）

1. **凭据文件格式**：最初按扁平的 `DEEPSEEK_API_KEY: sk-x` 写入。查
   `dsh-credentials-local` 的解析器才发现它要求 `version: 1` + `refs:` 嵌套，
   扁平布局会抛 `uses the pre-release flat layout`，**整个凭据文件加载失败**——
   比不写还糟。现已改为正确的嵌套格式，并在写入后调用 DSH 自己的解析器校验。
2. **备份路径超长**：备份文件名最初把绝对路径压平，在 Windows 上超过 260 字符上限，
   PowerShell 连读取都失败。现改为保留相对目录结构（`files/<包名>/lib/index.js`）。

## 4. 会话日志抢救与升级工具（`repair-session.mjs` / `upgrade.mjs`）

### 为什么需要

上游 bug：`llm-deepseek` 的流式 tool_call 增量守卫写成
`if (call.id !== void 0) block.callId = call.id`，网关在续帧里发**显式空串**时会覆盖
首帧捕获的真 id → `tool/call` / `tool/result` 以 `callId: ""` 落盘 → 加载校验
（有意设计的防损坏检查）拒绝 → 会话永久无法加载。上游在 `0.1.5-rc.2` 用
`acceptIdentity`（首个非空值优先）修复。

### `repair-session.mjs`

只改日志、不碰引擎写入路径。回填四处引用（缺一处都会让 UI 配对错乱）：
`tool-call-chunks.data.id`、`assistant/message` 的 tool-call 块 `id`、
`tool/call.data.callId`、`tool/result` 的 `message.source.callId` 与
`message.content[0].toolCallId`。

按 `step/start` 分段配对（重放会产生同名 turn/step，不能只按 turn/step 分组）。
物理格式：逐帧解码/重压（保持原始帧边界）、第一帧只放 header 一行、帧带 checksum、
**校验通过才写盘**、写前自动备份。

### `upgrade.mjs`

`npm i -g` 会整个替换 dsh 包目录、冲掉我们的补丁，所以把
「备份 → 安装 → 重打补丁 → 复验」串成一步。

### 本次实测（2026-09-19）

- 全量体检 22 个会话，发现 **2 个被毒化**（`c93d5f94` 119 处、`c28f3028` 5 处，
  均为 v0 格式，最后写入集中在 09-17 11:51–11:57）。
- 修复：分别回填 **931** 与 **25** 处，镜像 DSH 的 `assertMessageEventShape` 校验
  0 个不合规，用 DSH 自己的 `decodeStorageRecord` 验证逻辑事件流 seq 从 0 连续；
  磁盘回读复验 0 个不合规；重复执行 0 处回填（幂等）。
- 修复后全量体检 22 个会话 0 个异常。
- **修复脚本自身的一个 bug 被自检抓到**：最初更新了内存里的 `records[].text` 却用
  原始行数组重压帧，等于没改。现改为「用打过补丁的记录重建缓冲 → 校验缓冲 →
  才备份写盘」，并在写盘后做磁盘回读复验。
- 触发条件实测（直接探测中继）：续帧里 `tool_calls[].id` 为**空串**的路由必然触发
  （实测 `ByteDance-volcengine/DeepSeek-V4-Pro`、`Ali-dashscope/DeepSeek-V3.2`），
  字段**缺失**的路由不触发（实测 `*-GA` 系列、`SDU-AI/*`）。
- 升级预检：搜索插件 `0.1.2-rc.1` 与 `0.1.5-rc.2` 的 `lib/index.js` **SHA256 完全相同**，
  补丁可直接沿用；客户端 bundle 变了但**六个补丁锚点全部命中**，`node --check` 通过。
- #6686 投影风险预检：22 个 v0 会话 74881 个事件中，
  「残缺 message 体」与「可疑 surfaceOp」两种触发形状**均为 0** → 升级后投影无风险。
