# dsh-search-relay

让 **DeepSeek Harness（DSH）的 `web_search` 工具在中继（LiteLLM 等）后面也能用**。

DSH 自带的搜索插件依赖 Anthropic API 的**服务端**搜索工具（`web_search_20250305`）。
经 LiteLLM 之类的中继访问第三方模型时，中继不执行服务端搜索，模型只回一个
`tool_use(web_search, {query})`，插件拿不到 `web_search_tool_result` 就直接报错，
于是搜索功能整体不可用。

本仓库给插件加了 **relay 模式**：遇到这种情况由插件自己抓取搜索结果（Bing RSS，
失败回退 HTML 解析），并顺带给设置页补上缺失的「模型」输入框。

> 这不是 DeepSeek 官方仓库，是对 MIT 许可组件的本地改造版，见 [`NOTICE.md`](NOTICE.md)。
> 改造细节与验证记录见 [`docs/CHANGES.md`](docs/CHANGES.md)。

---

## 快速开始（Linux）

```bash
# 0) 前置：Node.js 已安装（DSH 本身跑在 Node 上）
node -v

# 1) 安装与本改造版本一致的 DSH
npm i -g @deepseek-ai/dsh@0.1.2-rc.1
dsh --version

# 2) 取仓库（私有仓库，先登录，见下一节）
gh auth login
gh repo clone HTwoOhwater/dsh-search-relay
cd dsh-search-relay

# 3) 先预览要做什么（不会写任何文件）
node install.mjs --check

# 4) 安装（顺手把中继密钥写进 ~/.dsh/.credentials.yaml）
node install.mjs --api-key sk-你的中继密钥

# 5) 重启 dsh web
dsh web
```

然后浏览器里刷新页面 → **设置 → 插件 → 插件配置**，Web search 卡片上应该能看到
**「模型」**输入框；让 agent 随便搜一下验证。

---

## 私有仓库怎么 clone

仓库是私有的，另一台机器上四选一：

**A. 用 gh 登录（最省事）**

```bash
gh auth login          # 选 GitHub.com → HTTPS → 浏览器/设备码登录
gh repo clone HTwoOhwater/dsh-search-relay
```

**B. 用 Personal Access Token**

在 GitHub → Settings → Developer settings → Fine-grained tokens 建一个只读
（Contents: Read）的 token，然后：

```bash
git clone https://<TOKEN>@github.com/HTwoOhwater/dsh-search-relay.git
```

**C. 用 SSH key**

把那台机器的公钥加到 GitHub 账号，然后：

```bash
git clone git@github.com:HTwoOhwater/dsh-search-relay.git
```

**D. 完全不折腾认证**

GitHub 网页上 Code → **Download ZIP**，把 zip 传到那台机器解压即可
（`install.mjs` 不依赖 git，解压出来的目录就能直接跑）。

---

## 安装器参数

```
node install.mjs [选项]

  --dsh <路径>       指定 DSH 安装目录（默认自动探测：which dsh → npm root -g → 常见路径）
  --check, -n        只预览，不写任何文件
  --restore          还原最近一次备份
  --from <目录>      配合 --restore，指定要还原的备份目录
  --api-key <key>    写入 ~/.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY
  --base-url <url>   写入 settings.yaml 的接口地址
  --model <name>     写入 settings.yaml 的模型名
  --no-client        跳过客户端「模型」字段补丁
  --no-settings      不碰 ~/.dsh/settings.yaml
  --overlay-client   客户端整包覆盖（仅当 DSH 版本完全一致时用）
  -h, --help         帮助
```

安装器做四件事：覆盖 host 插件 → 打客户端补丁 → 补 `settings.yaml` 配置段 →
检查密钥。**所有被覆盖的文件都会先备份**到
`~/.dsh/dsh-search-relay-backup/<时间戳>/`（保留相对目录结构 + `manifest.json`）。

---

## 配置

`~/.dsh/settings.yaml`（安装器会自动追加，示例见 [`config/settings.example.yaml`](config/settings.example.yaml)）：

```yaml
web-search-deepseek:
  baseURL: https://xplt.sdu.edu.cn:4000/v1
  model: ByteDance-volcengine/DeepSeek-V4.1-Flash
```

两个坑：

- **`baseURL` 要写到 `/v1` 为止**。插件会自己拼 `/messages`；写成
  `.../v1/messages` 会变成 `.../v1/messages/messages` → 404。
- **`model` 必须在中继的团队白名单里**。报
  `team not allowed to access model ... Tried to access X` 时，报错信息里会列出
  可用模型，挑一个填进去即可。不填则用插件默认值 `deepseek-v4-flash`，多半会撞白名单。

密钥单独放 `~/.dsh/.credentials.yaml`（**不进仓库**）。注意这个文件的格式是
`version: 1` + `refs:` 的**嵌套**结构，DSH 的解析器很严格，扁平写法会被整个拒绝加载：

```yaml
version: 1
refs:
  DEEPSEEK_API_KEY: sk-xxxxxxxxxxxx
```

`node install.mjs --api-key sk-xxx` 会按这个格式帮你写好，并用 DSH 自带的解析器校验一遍
（遇到旧版扁平布局或内联 `refs: {}` 会拒绝改写而不是写坏文件）。

也可以用环境变量 `DEEPSEEK_API_KEY`，前提是 `dsh web` 进程能看到它。

---

## 验证是否成功

1. `dsh web` 重启后打开 GUI；
2. 设置 → 插件 → 插件配置 → Web search 卡片能看到**「模型」**输入框，并且能改能存；
3. 让 agent 搜一下（例如"搜一下 DeepSeek 最新消息"），能返回带链接的 sources 就通了。

如果搜索报 `DeepSeek returned no web_search_tool_result blocks`，说明 relay 模式没生效
（host 插件没重启，或覆盖失败）。

---

## 回滚

```bash
node install.mjs --restore                 # 还原最近一次安装前的状态
node install.mjs --restore --from ~/.dsh/dsh-search-relay-backup/<时间戳>
```

还原后重启 `dsh web`。备份目录可以随时手动删。

---

## 工作原理

```
DSH 的 web_search 工具
  └─ ctx.web.search({query})  →  插件 search()
       └─ POST {baseURL}/messages      （Anthropic 格式，带 web_search_20250305 工具）
            ├─ 响应含 web_search_tool_result 块
            │     → 原生路径：直接用（接真正支持原生搜索的端点时走这条，行为同上游）
            └─ 响应含 tool_use(web_search, {query})
                  → relay 路径：插件自己抓取
                       ├─ cn.bing.com/search?q=...&format=rss    RSS 优先，解析 <item>
                       ├─ www.bing.com/search?q=...&format=rss   换域名重试
                       └─ cn/www.bing.com/search?q=...           HTML 回退，解析 <li class="b_algo">
                  → 每个 query 最多 10 条，按 URL 去重（跳过 bing.com/ck/ 跳转链接）
                  → query 数量受 maxUses 限制
                  → 结果直接作为 sources 返回
```

relay 路径**不做第二次模型调用**：省一次往返，也避免模型对着抓来的正文编造。
抓到的 sources 会交给主模型自己读。

---

## 目录结构

```
dsh-search-relay/
├── install.mjs                       一键安装/还原补丁（Node，跨平台）
├── upgrade.mjs                       升级 DSH 并在升级后自动重打补丁
├── repair-session.mjs                抢救被空 callId 毒化的会话日志
├── config/settings.example.yaml      配置示例
├── docs/CHANGES.md                   改了什么、为什么、怎么验证的
├── NOTICE.md                         第三方代码与许可说明
├── LICENSE                           MIT（上游 DeepSeek 版权）
└── payload/
    ├── dsh-web-search-deepseek/      改造后的 host 插件（完整包）
    │   ├── lib/index.js              ← relay 模式的核心改动
    │   └── README.md / README.zh.md  插件文档（已补 relay 说明）
    └── client-ui/
        ├── patch-client.mjs          客户端「模型」字段补丁（幂等、锚点式）
        └── lib/client.js             打好的完整文件（仅 --overlay-client 兜底用）
```

---

## 附：已知上游 bug —— 会话被「空 callId」毒化

**症状**：打开某个历史会话时弹出

```
历史加载失败：stored session "session-…" is corrupt:
failed validation: Error: session event at seq NNNNN message must have tool source
```

**这不是本插件的问题，是上游 bug**，社区有数十条同类报告（
[#3269](https://github.com/deepseek-ai/deepseek-harness/discussions/3269)、
[#2169](https://github.com/deepseek-ai/deepseek-harness/discussions/2169)、
[#1915](https://github.com/deepseek-ai/deepseek-harness/discussions/1915)、
[#4385](https://github.com/deepseek-ai/deepseek-harness/discussions/4385)、
[#4387](https://github.com/deepseek-ai/deepseek-harness/discussions/4387)、
[#4611](https://github.com/deepseek-ai/deepseek-harness/discussions/4611) …）。

**成因**：`llm-deepseek` 处理流式 tool_call 增量的守卫写成

```js
if (call.id !== void 0) block.callId = call.id;   // 空串 "" 也满足条件，会覆盖首帧的真 id
```

网关/中继在续帧里发**显式空串** `id: ""` 时会覆盖首帧捕获的真 id，于是 `tool/call`
与 `tool/result` 都以 `callId: ""` 落盘。加载时的防损坏校验（有意设计，社区共识是
**不该放宽**）要求 callId 非空 → 整个会话永久无法加载。

**上游修复**：`0.1.5-rc.2` 起改成 `acceptIdentity(current, incoming)`（首个非空值优先）。
`0.1.2-rc.1` 及更早版本仍受影响。

**判断你的中继会不会触发**：用流式请求让模型调一次工具，看续帧里的 `tool_calls[].id`
是**字段缺失**还是**空串**——缺失不会触发，空串必然触发。实测某些网关路由（LiteLLM 后面
的非 GA 模型）会发空串。

### 抢救已经坏掉的会话

```bash
node repair-session.mjs --scan                 # 体检所有会话，列出会被拒绝的
node repair-session.mjs --scan --apply         # 备份并修复全部
node repair-session.mjs <session.jsonl.zstd> --apply   # 修单个
node repair-session.mjs --restore              # 还原最近一次备份
```

它为每个空 id 生成唯一占位 id，并**同步回填四处引用**（缺一处都会让 UI 配对错乱）：
`tool-call-chunks` 的 `data.id`、`assistant/message` 里 tool-call 块的 `id`、
`tool/call` 的 `data.callId`、`tool/result` 的 `source.callId` 与 `content[0].toolCallId`。

物理格式上踩过的坑（脚本已处理）：会话日志是**拼接式 zstd 帧**容器，必须逐帧解码重压；
**第一帧必须恰好是 header 一行**（压成单帧会让整个 DSH 启动失败）；帧要带 checksum；
**校验通过才写盘**，写前自动备份。

### 升级到修复版

```bash
# 先停掉 dsh web（Windows 上 npm 覆盖正在使用的文件可能失败）
node upgrade.mjs --check          # 看看会做什么
node upgrade.mjs                  # 升级 + 自动重打补丁 + 复验
```

`upgrade.mjs` 先备份被补丁的文件，再 `npm i -g @deepseek-ai/dsh@0.1.5-rc.2`，
然后调用 `install.mjs` 重新打上搜索 relay 补丁与客户端「模型」字段补丁。

> 搜索插件在 `0.1.2-rc.1` 与 `0.1.5-rc.2` 之间**字节完全相同**（SHA256 一致），
> 所以 relay 补丁可以直接沿用，无需移植。

**升级后旧会话会被自动迁移**：日志格式从 v0 升到 v3，写成新的 `session.v3.jsonl.zstd`，
**原 v0 文件保留**。注意一个上游未修的后续问题（
[#6686](https://github.com/deepseek-ai/deepseek-harness/discussions/6686)）：迁移后若某些事件
缺 `data.message`，三个官方投影会无保护读取而抛
`failed to project session … reading 'content'`。可以提前离线预检：扫描 v0 日志里
是否存在「类型暗示有 message 体但 `data.message` 缺失」或「replace 形状的 `surfaceOp`
解析不到位置」这两种形状，为 0 则升级后投影不会出问题。

---

## 已知限制

- **搜索源只有 Bing**（RSS + HTML 回退）。没接 Google/Brave——那些要么要 key，要么被墙。
- **relay 路径不总结**：只返回抓到的标题/摘要/链接，由主模型自己读。
- **host 插件是整包覆盖**，和 DSH 版本耦合。DSH 升级后若搜索异常，先怀疑版本差异
  （安装器会检查并警告版本不一致）。
- **客户端补丁是锚点式**：DSH 升级导致锚点消失时会明确报错并跳过，**不会**写坏客户端；
  最坏情况只是设置页看不到「模型」输入框，搜索功能不受影响（仍可在 `settings.yaml` 里配 `model`）。

---

## 验证记录

改造不是"看起来能跑"就完事，两轮验证都做了：

- **补丁正确性**：把当前机器上已验证可用的客户端文件「反向还原」成上游原版，再用
  `patch-client.mjs` 重新打一遍 → 与原件 **SHA256 逐字节一致**；再跑一次 → 零改动（幂等）。
  补丁后的 `lib/client.js` 通过 `node --check`。
- **安装器端到端**：假 DSH 安装目录 + 假 `$HOME`，16 项检查全过 —— `--check` 不写入、
  host 覆盖正确且保留 `package.json`、客户端结果与已知可用版本一致、`settings.yaml`
  追加且不破坏原内容、密钥写入、备份生成、重复安装幂等、两种 `--restore` 都能还原。

细节见 [`docs/CHANGES.md`](docs/CHANGES.md)。

---

## English quick start

```bash
npm i -g @deepseek-ai/dsh@0.1.2-rc.1
git clone <this repo> && cd dsh-search-relay
node install.mjs --check                 # dry run
node install.mjs --api-key sk-xxxx       # install
dsh web                                  # restart
```

The installer locates your DSH install, backs up every file it overwrites to
`~/.dsh/dsh-search-relay-backup/<timestamp>/`, overlays the patched
`dsh-web-search-deepseek` plugin (relay mode: the plugin scrapes Bing itself when the
relay returns `tool_use` instead of native `web_search_tool_result` blocks), applies an
idempotent anchor-based patch that adds a **Model** field to the settings UI, and appends
the `web-search-deepseek` section to `~/.dsh/settings.yaml`.
Roll back with `node install.mjs --restore`.
