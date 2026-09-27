# dsh-opencode-suite

**一个插件，把 OpenCode 需要的事全做完。**

它覆盖四件本来要装四个插件才能做的事：

- 挂在一条 OpenCode Zen 路由后面的多 Key 池，额度感知、自动切换
- 按会话注入请求头，供网关做粘滞与统计
- 两档 Zen 模型目录在一张卡里双向管理
- 用量看板，以及管以上全部的六个 Agent 工具

一行插件配置、一个 settings 命名空间（`opencode-suite`）、一个 Remote
（`opencodeSuite`）、一个设置页、六个 Agent 工具。

```sh
dsh plugin --profile <name> add dsh-opencode-suite
```

> English documentation: [README.md](README.md)

---

## 它解决什么

- **自动换号。** 多个 OpenCode Go 账号挂在同一个路由后面。某个 Key 额度耗尽或凭据
  失效时，请求会**在任何内容产出之前**切到下一个可用 Key，失败的那次不会出现在
  对话记录里。
- **用量看板。** 每个 Key 的 5 小时滚动 / 每周 / 每月已用百分比进度条，以及重置倒计时，
  数据来自 OpenCode 的 usage 接口。
- **两档模型一处管。** Go 档由本插件自己服务，所以目录在本页管理（勾选、图片能力、
  真实容量）；免费档属于 `llm-pi-ai`，只通过 settings 缝隙读写它的模型列表。
- **请求带会话标识。** Harness 的会话 id（默认哈希成定长短码）挂到发往 `opencode.ai`
  的请求头上，让网关按会话做粘滞与统计。只改请求头，不改请求体。
- **给模型用的工具。** 不打开浏览器也能查看和修复 Key 池、两档目录。

## 先把两档说清楚

OpenCode Zen 的两个路由**不是「免费额度 + 付费额度」**，它们不是同一种东西：

| 路由 | 是什么 | 端点 | 模型 id | 「额度」 |
| --- | --- | --- | --- | --- |
| `opencode` | 按量计费的**价目表**，其中若干行标价 `Free` | `https://opencode.ai/zen/v1` | 免费行里 `big-pickle` 无后缀，其余带 `-free` | 无 |
| `opencode-go` | **Go 订阅** | `https://opencode.ai/zen/go/v1` | 无后缀 | 5 小时滚动 / 每周 / 每月，本插件切号依据 |

几个容易踩的点：

- **「免费档」是逐模型的定价属性，不是一笔可以随便花的免费额度。** 线上
  `zen/v1/models` 当前公开列出 70 个 id，其中只有 6 个是官方标价 `Free` 的
  （`big-pickle`、`mimo-v2.5-free`、`ling-3.0-flash-fin-free`、
  `nemotron-3-ultra-free`、`nemotron-3.5-lightning-free`、
  `muse-spark-1.3-contributor-free`）；剩下 64 个（Claude、GPT、Gemini 等）挂在同一个
  端点上但**要按量付费**。列表接口只给 id、不给价格，所以插件用一份官方免费清单做闸门，
  不靠猜。
- **带 `-free` 后缀 ≠ 免费。** `big-pickle` 免费但没有后缀；反过来
  `deepseek-v4-flash-free` 和 `muse-spark-1.2-contributor-free` 有后缀却不在定价表的免费行里，
  本插件不会把它们当免费模型上架。你手动配置过的 id 不受此限制，始终受管理。
- **免费清单会轮换。** 官方把限时免费模型换代（`muse-spark-1.2-contributor-free` →
  `muse-spark-1.3-contributor-free`），并有独立的「Deprecated models」下架表。写死白名单
  注定过期，所以本页的漂移检测是对着线上列表算的。
- **你池子里那套百分比属于 Go 档，不是免费档。** 5 小时滚动 / 每周 / 每月是订阅额度，
  免费档没有这种东西。

## 依赖

- DeepSeek Harness `0.1.5-rc.1` 或更新（见 `package.json` 的版本约束）。
- Node `>= 20`。
- 至少一个 OpenCode Go API Key，或者已经配置好的免费档。
- 想要设置页就需要 web profile；宿主侧功能在 headless 下同样可用。

## 安装

```sh
dsh plugin --profile <name> add dsh-opencode-suite
```

本地路径安装用 `add file:/绝对路径` 也一样。

**pnpm 版本不匹配时手装。** `dsh plugin` 是个 pnpm 转发器，用的是**当前目录**解析到的
pnpm。在 harness 源码目录里执行时，harness 的 `packageManager` 会让它用另一个 pnpm 大版本，
而 profile 的 `node_modules` 是先前版本装的，于是直接失败：

```
[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location
... currently linked from the store at .../store/v10
pnpm now wants to use the store at .../store/v11
```

不要为此重装整个 profile（那会改写 lockfile 并动到所有插件）。改成在 profile 目录里用
它自己的 pnpm 走一次普通安装，效果与转发器相同，只是少了自动同步 bundles 这一步：

```sh
cd ~/.dsh/profiles/<name>
# 先把依赖写进 package.json（dependencies + dsh.profile.bundles），再：
pnpm install
```

然后**在「设置 → 模型」里删掉 `opencode-go` 供应行**。该路由由本插件的 Key 池接管；
在其他适配器仍持有它之前，插件保持休眠，设置页会显示接管提示。已有会话无需任何改动。

免费档路由 `opencode` 保留它的 `llm-pi-ai` 行 —— 本插件只动它的模型列表。

Key 可以在设置页的「Key 管理」里加，也可以用 `oc_suite_pool` 工具加。密钥经由凭据服务
写入各个 Key 的引用名下，不进入 settings、日志或任何返回值。

## 配置

每一项都是可选的；下面是 bundle patch 写入的默认值。

```yaml
- id: opencode-suite
  name: 'dsh-opencode-suite'
  config:
    route: opencode-go            # 私有路由用 opencode-suite-go
    keys: []                      # {id, label, apiKeyEnv}，由设置页管理
    preemptAtPercent: 100         # 100 = 只在失败时切换
    switchAfterConsecutiveFailures: 0   # 0 = 关闭
    modelMode: all                # all = 跟随目录；custom = 只用 models
    models: []
    imageModels: []               # 声明为接受图片输入的模型 id
    modelCapacities: {}           # {id: {contextWindow, maxTokens}}
    usageBaseUrl: https://opencode.ai/zen/go/v1/usage
    modelsBaseUrl: https://opencode.ai/zen/go/v1/models
    freeModelsBaseUrl: https://opencode.ai/zen/v1/models
    usageRefreshMs: 30000
    timeoutMs: 15000
    usageLogEnabled: true          # 本地「按天 × 模型」token 统计
    usageLogSource: live           # live = 数本进程流过的请求；log = 折叠会话日志
    usageLogWindowDays: 7          # 卡片与工具报告的窗口
    usageLogRetentionDays: 90      # 保留多少天的日桶（是上限，不是窗口）
    usageLogSessionsPerSweep: 12   # 一次刷新最多打开多少个变化过的会话
    usageLogSweepMaxMs: 4000       # 一次刷新最多花的墙钟时间
    modelWatchEnabled: true        # 后台核对两档列表的新增/下架
    modelWatchIntervalMs: 900000   # 15 分钟
    notifyImEnabled: false         # 用 IM 插件推送上新消息
    notifyImBotId: ''              # 在卡片里从 listBots() 选
    notifyImTargetId: ''           # 在卡片里从 listTargets() 选
    sessionHeaders:
      enabled: true               # 默认开启
      nanoidSessionId: true
      nanoidLength: 8             # 4..32
      nanoidAlphabet: alphanumeric  # 或 urlsafe
      seedSessionId: false
      verbose: false
      providers: [opencode, opencode-go]
      hosts: [opencode.ai]
      baseURLs: []
      headers: [x-opencode-session, x-session-affinity, x-client-request-id, x-session-id]
      extraHeaders: {}
      userAgent: ''
      disableFetchInjection: false
```

`preemptAtPercent` 是**避让**规则：5 小时滚动窗口**或**每周窗口任一达到阈值就提前切走。
`switchAfterConsecutiveFailures` 统计非额度类失败（限流 / 服务端 / 超时）。额度耗尽和
凭据失效始终立即切换，不受这两项影响。

### 图片输入声明

上游 `models` 接口只公布 id，**不声明任何模型的图片能力**，所以 Go 档接入的模型默认全部
读作纯文本 —— `read_image` 工具和对话里贴图都会对该模型被拒。声明是逐模型的，四处写的是
同一份 `imageModels`：

| 入口 | 写法 |
| --- | --- |
| 设置页 | Go 档模型卡里每个模型一个「图片」勾选框 |
| 配置 | `imageModels: [id, ...]` |
| 工具 | `oc_model_add` 的条目带 `input: ['text', 'image']` |
| RPC | `putConfig({ imageModels: [...] })` |

保存即时生效，不需要重启或重连。目录本身已声明图片的模型不必重复声明（卡上显示为「目录
已声明」）；保存时**只写入目录没声明的部分**，不会覆盖官方声明，所以拉取新目录不会把你
手动声明的能力清掉。

请求侧的图片预算是另外三个常量（`maxRequestImageBytes` 20 MiB、
`requestImagePixelBudget` 2048×2048、`requestImageMaxBytes` 1 MiB），按路由生效。

## 设置页

**设置 → OpenCode 套件**（侧边栏一项，id `opencode-suite`）从上到下是：

1. **会话底部一行** —— 输入框下面、和速度/命中率那排在一起：今日 token 与数据来源，
   以及一个「还有几个新模型没处理」的点。点那个点只在底部压掉提示，**不动 host 的
   待处理清单**（那是下面那张卡要用的工作清单）。纯客户端改动，刷新页面即生效。
2. **模型上新提醒** —— 后台核对列表后还没处理的变动。
2. **接管状态条** —— 服务中 / 等待接管、当前 Key、当前切号策略、最近一次切换及原因。
2. **Go 档模型选择** —— 「全部模型」或自定义勾选、逐模型图片能力声明、「拉取模型」
   对接线上接口，以及容量编辑器。
3. **切号策略** —— 两条自动切号规则。
4. **每个 Key 一张卡** —— 用量进度条、状态徽章，以及该状态下允许的操作
   （切换 / 停用 / 启用 / 清除失效 / 清除耗尽）。
5. **Key 管理** —— 新增、改名、粘贴密钥、删除。
6. **本地用量（按天 × 模型）** —— 下面「本地用量」一节说的那套统计。
7. **免费档模型** —— 已配置 vs 线上；勾选线上模型即上架，取消勾选即下架；同时显示
   已下架的条目和 settings 修订号。
8. **会话标识** —— 总开关、短码长度与字符集、seed 与 verbose 开关、匹配的路由/主机/头名、
   额外固定头、User-Agent 覆盖，以及最近 20 次注入的 URL、头名、会话 id、发出的短码和错误。

## 模型上新盯盘

模型半夜上线，等到你打开页面才知道 —— 卡片和 `oc_model_status` 里的漂移都是**被问到时**
才算的。盯盘把这个缺口补上：按 `modelWatchIntervalMs`（默认 15 分钟）轮询两档列表，
并把「已经见过什么」记在 `$DSH_HOME/opencode-suite.watched.json`。

- **第一次是基线，不是通报**：新装、状态文件被删、重启，都会静默地把线上已有的收下。
- 之后每个新 id **只通报一次**，带上首次发现时间，并一直挂在卡片上直到你处理。
  下架的 id 同样通报；下架后又回来的，算新消息。
- 卡片（「模型上新提醒」）按档列出，每档三个动作：拉取到 Go 档 / 上架到免费档 / 知道了。
  `oc_model_status` 与 `oc_suite_status` 在文本里报同一份消息；真的发现新东西时宿主日志
  也会打一行，所以 headless 跑也能知道，不依赖有人开页面。
- 「知道了」清掉的是通知，不是「见过」的集合：被打消的 id 要等它下架再回来才会再通报。
- 某一档请求失败只记为错误，不会挡住另一档。

**推送到 IM。** 装了 IM 插件后，盯盘可以借它已配好的投递目标发一条消息：卡片直接列出
`listBots()` × `listTargets()` 让你选，选择存在配置里，**不用把任何 id 抄进文件**。
发现有新 id 的那一轮发一次（基线那轮静默，之后没有新东西也静默）。发失败不影响别的事 ——
待处理清单还在，卡片照样显示该上架什么。本插件**不负责建机器人**：那需要平台凭据
（Telegram token、飞书应用、微信登录），属于 IM 插件自己的设置。

## 本地用量：按天、按模型

Go 用量接口只回答一个问题 —— 每个 **Key** 的额度窗口用掉了百分之多少，而且只给百分比。
它既不公布 token 数，也没有模型维度的拆分，所以「哪个模型在烧额度」不可能从那里得到。
这个答案来自 Harness 本来就在写的日志：每条 `assistant/message` 都带着产生它的模型，
以及厂商自己报的 `usage` 数字。

**本地用量**卡把它们按**本地自然日**和模型折叠，窗口可选 1 / 7 / 30 / 90 天：

- 一条按天的柱条，不展开表格也能看出哪天尖了；
- 一张模型表：调用数、输入、缓存读、输出、合计、占比；
- 缓存读占全部 token 的比例 —— 订阅制下真正推动额度窗口的就是这一项，不是输出量；
- 扫描进度，所以「扫了多少」永远不用猜。

**两个来源，一套数字。** `usageLogSource` 决定数字从哪来，而且只能选一个 ——
同一次调用被两边各数一次就重复了：

| 来源 | 数什么 | 代价 | 看不到什么 |
| --- | --- | --- | --- |
| `live`（默认） | 本进程自己流过的每一次 usage 报告，回合结束即入账 | 零成本：复用套件本来就有的 `llm/stream` 拦截（那是为了会话头） | 插件启用之前的历史，以及别的进程跑的调用 |
| `log` | 会话日志里每条完成的模型回答（`assistant/message`） | 每次刷新有上限，但大库首次全量要几分钟、分摊在若干次刷新里 | 重试后没有产出回答的那次尝试 |

两种来源都计入子代理会话，因为它们调的是同一个额度池。日期键取**本地**日期，
所以「今天」就是你以为的那个今天。

`live` 计数平时在内存里，所以它会节流写入 `$DSH_HOME/opencode-suite.usage.json`（退出时再写一次），
启动时从该文件续上：宿主重启不会把当天的账清零。文件缺失或损坏就从本次运行重新数起。

**`log` 一次刷新的代价。** 修订号没变的会话直接跳过；变长的会话只从上次读到的 offset
往后读，所以没有新增的那一天开销为零。一次刷新最多打开 `usageLogSessionsPerSweep` 个会话、
最多花 `usageLogSweepMaxMs` 毫秒，优先折叠增长最快的；剩下的排队等下一轮，
`sweep.complete` 会如实说明。会话数上千的库，第一次完整统计因此是在若干轮里收敛的，
不会卡住一次页面加载 —— 实测 1487 个会话的库，一次刷新约折叠十几个会话、耗时 5 秒左右，
冷启动全量要几分钟。会话日志连续读不了 3 次就先放一放（日志被修好后修订号会变，自动回来），
免得一个坏日志把扫描永远拖成「未完成」。

## 容量

模型列表接口**只公布 id，不公布上下文窗口**。所以：

- 官方目录自带描述的模型，以目录为准（只读展示）；
- 动态拉取接入的模型使用文档默认值（128k 上下文 / 32k 输出），在容量编辑器里标为
  *默认值*；
- 在那里填入真实数值会写入 `modelCapacities`，下一次请求即生效；修正过的行标为 *已修正*。

保存时发送的是**整张** map，因为宿主是整体替换：只发变更会让其他已修正的行被静默改回默认值。

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `oc_suite_status` | 接管状态、Key 池名册 + 每个 Key 的额度、当前暴露的模型、免费档漂移 |
| `oc_suite_pool` | `switch` / `disable` / `enable` / `clear-invalid` / `clear-exhausted` |
| `oc_usage_models` | 本地 token 按天、按模型的用量 —— 唯一的「按模型」答案来源 |
| `oc_model_status` | 分档的「已配置 vs 线上」对比与漂移 |
| `oc_model_add` | 把线上 id 或完整条目加入某一档 |
| `oc_model_remove` | 从某一档移除 id |
| `oc_model_sync` | 预览（或 `apply`）两档的线上↔配置同步 |

四个 `oc_model_*` 是本套件的规范工具名。

## 工作原理

**选号。** Key 池维持一个当前 Key。一次调用先通过凭据服务取出该 Key 的密钥，然后开始流式请求；
如果失败发生在第一个内容块之前，就静默切到下一个可用 Key 并重试。已经产出内容之后才发生的失败
会如实上报，不会重试——此时对话记录已经是半截的。Key 状态有 `healthy`、`exhausted`、
`invalid`、`disabled`；额度耗尽的 Key 在滚动窗口重置、usage 接口确认之后会自行复活。

**会话头。** 由两半配合：`llm/stream` 瀑布记录一次流式调用属于哪个会话（`AsyncLocalStorage`
作用域），`globalThis.fetch` 包装器把请求头加到「URL 命中 `hosts`/`baseURLs` 且 provider 命中
`providers`」的请求上。只有请求头被改动，请求体和响应都不碰。短码是对会话 id 做确定性 SHA-256
位移得到的，所以一个会话永远对应同一个线上标识。

**路由归属。** 插件在路由空闲时注册适配器，并在 `llm/adapters-updated` 时重试，因此运行时删掉
`llm-pi-ai` 的供应行就够了，不需要重启。

## 从其他 OpenCode 插件迁移

1. 从 profile 的 `dsh.profile.bundles` 里移除其他所有 OpenCode 插件 —— 一条路由只能有一个
   持有者。
2. 如果启动时写入过对应的 `~/.dsh/settings.yaml` 段落，一并删掉。
3. 安装本插件，在设置页填回 Key。
4. 删掉 `opencode-go` 供应行（本插件接管该路由）。
5. 之前在别处设过的模型容量，在容量编辑器里重新填一遍 —— 本插件用自己的存储。
6. Go 档模型卡里的逐模型「图片」声明也重设一次 —— 它存在本插件的配置里，不在 `llm-pi-ai`。
7. **迁走「拉取模型」缓存。** 这是最容易漏的一步，漏了不会报错，只会少几个模型：
   同类旧插件把拉取的目录存成扁平的 `[{id, name}]` 数组，文件名是
   `$DSH_HOME/<插件名>.models.json`；本插件读的是 `$DSH_HOME/opencode-suite.models.json`，
   形状是 `{version: 1, routes: {<route>: [{id, name}]}}`。不迁的话，官方目录
   （随 `pi-ai` 发行）之外的模型会静默消失——实测线上 Go 档 37 个 id 里，官方目录只收了 27 个，
   差的 10 个全靠这份缓存。转换示例：

   ```sh
   node -e "const fs=require('fs');const old=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
   const routes={'opencode-go':old.filter(e=>e&&typeof e.id==='string').map(e=>({id:e.id,name:e.name||e.id}))};
   fs.writeFileSync(process.argv[2],JSON.stringify({version:1,routes},null,2)+'\n')" \
     ~/.dsh/<旧插件名>.models.json ~/.dsh/opencode-suite.models.json
   ```

   也可以不迁，装好后在模型卡里点一次「拉取模型」，效果一样。

> 凭据不用迁：本插件沿用各路由原本的 `apiKeyEnv` 引用名，`~/.dsh/.credentials.yaml` 里的
> 条目原样继续生效。

## 排障

**明明 key 是好的，却报 "every key is exhausted, disabled, or invalid"。**
OpenCode 网关会把好几种互不相干的拒绝，用**和「key 失效」完全相同的 401/403 状态码**
发回来，而 harness 把它们一律标成 `AUTH`：

| 提供方错误 | 状态码 | 含义 | 是 key 的问题吗 |
| --- | --- | --- | --- |
| `AuthError` | 401 | API key 无效 / 缺失 | **是** |
| `ModelError` | 401 | 该账号或该线格式下不提供此模型 | 否 |
| `RegionError` | 403 | 该模型在您所在国家/地区不可用 | 否 |

key 池按提供方自己的错误身份分类，而不是按状态码，所以 `ModelError` 和 `RegionError`
不会动任何 key —— 不轮换（换一把 key 答案一样），原样上报。只有 `AuthError` 才会把 key
标记为失效。旧版本写下的失效标记会在状态文件加载时**重新判定**，升级即可自愈。

**某个模型报 `RegionError`（`This model is not available in your country.`）。**
这是真的地区授权限制，但**判定依据是这次请求的出口地区** —— 不是 key，也不是模型名写错。
同一个 key、同一个请求体，只换出口就结论相反：

```sh
curl -s -X POST https://opencode.ai/zen/go/v1/responses \
  -H "Authorization: Bearer $OPENCODE_GO_KEY_A" -H "Content-Type: application/json" \
  -d '{"model":"muse-spark-1.3-contributor","input":"hi","max_output_tokens":16}'
```

所以**先确认请求实际从哪儿出去，再怀疑模型**，否则容易把地区问题误判成"这个模型不能用"：

```sh
curl -s https://www.cloudflare.com/cdn-cgi/trace | grep -E '^(ip|loc)='
```

要留意**同一台宿主的不同协议可以走不同出口**：IPv4 走代理、IPv6 直连本地是常见配置，
而 Node 默认优先 IPv6，于是 `curl`（默认 IPv4）能通、harness 却拿到 403 —— 看着像插件的 bug。
dsh 侧的出口由**启动它的环境**决定：`http_proxy` / `https_proxy` / `no_proxy` 在启动时
被读取一次，之后每个 `fetch` 都按它走（见 `@deepseek-ai/dsh-http-proxy`）。

两种处理：换成对当前出口可用的模型（多数 Zen 模型没有地区限制），或者让 dsh 的出口落在
该模型可用的地区 —— 后者是否合乎服务商条款，由你和 OpenCode 之间决定。

另外注意 Zen 是**逐模型**指定线格式的，`/chat/completions` 不是万能入口：
muse-spark、grok-4.6 走 Responses API（`/responses`），glm / kimi / deepseek 走
`/chat/completions`。拿错入口会得到 `ModelError` 或 `500`，与可用性无关。
本插件按 pi-ai 目录逐模型取线格式，不需要你手工指定。

## 开发

```sh
# node_modules 需要能解析到 harness 的 peer 依赖（react、cordis、zod 等）：
# 指向 harness 工作区，或一个软链接。
pnpm test        # 等价于 node --test test/*.test.mjs
```

测试覆盖：纯宿主模块；装配后的 Cordis 插件（路由接管、失败切换、模型门禁、会话作用域、
完整 RPC 表面）；Typert 清单对真实 loader 的校验；以及浏览器 bundle —— 客户端测试会在
`window` stub 下真正执行它并对整页做服务端渲染。

改完源码要让已安装的 profile 生效时注意：`file:` 依赖是**安装时拷贝**的，`pnpm install`
在 spec 没变时会报 “Already up to date” 而**不会重新拷贝**。要么重新 `add` 一次，要么
`pnpm install --force`。

## 已知边界

- usage 接口是额度的唯一真相来源，它是轮询而非推送，看板最多滞后一个刷新周期。
- models 接口不公布容量，接入的模型从文档默认值起步，直到你修正。
- 会话头作用于命中主机、且走 `fetch` 的请求；如果某个 provider 通过其他传输层访问
  `opencode.ai`，不在覆盖范围内。
- 免费档列表是直接写进 `llm-pi-ai.providers.opencode.models` 的；如果 settings 提供方是
  只读的，那张卡也会变成只读。

## 许可

MIT。部分代码改编自先前的 MIT 许可 OpenCode 插件，所要求的版权声明保留在
[LICENSE](LICENSE) 中。

