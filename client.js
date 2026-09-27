// Client half of dsh-opencode-suite.
//
// Hand-written browser bundle in the lazy-CJS format the client module loader
// expects: it only REGISTERS the factory; the body runs at materialization.
//
// It mounts the `opencodeSuite` Remote, registers one `settings.section`
// sidebar entry ("OpenCode 套件"), and renders the whole suite on that one
// page: the pooled Go tier (usage dashboard, key management, switch policy,
// model selection with capacities), the free tier's model list, and the
// opencode session-header controls with their injection diagnostics.
//
// Everything this page shows comes from the `opencodeSuite` Remote defined in
// index.js and mirrored in typert.host.js — the panel adds no private RPC and
// never reads the settings file directly.

window.__ModuleLoader__.load({
  id: 'dsh-opencode-suite',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const NS = 'settings.opencodeSuite'
    const inject = ['slots', 'locale', 'remote']

    const zh = {
      nav: 'OpenCode 套件',
      title: 'OpenCode 套件',
      subtitle: 'Key 池 · 双档模型 · 会话标识，一处配置',
      loading: '查询中…',
      loadFailed: '加载失败',
      paused: '连续失败，已暂停自动刷新',
      refresh: '刷新',
      refreshing: '刷新中…',
      updatedAt: '数据更新于',
      actionFailed: '操作失败',
      yes: '确定',
      cancel: '取消',

      // ── 接管状态 ──────────────────────────────────────────────
      takeoverServing: '服务中 · 路由 opencode-go 已接管',
      takeoverOwnRoute: '自有路由模式 · opencode-suite-go',
      takeoverWaiting: '等待接管',
      takeoverWaitingHint: 'opencode-go 路由当前由其他插件持有。请在「设置 → 模型」中删除 opencode-go 供应商行，本插件会自动接管，历史会话无需任何改动。',

      // ── Key 池 ────────────────────────────────────────────────
      poolTitle: 'Key 池',
      poolHint: '每个 Key 对应一个 OpenCode Go 账号。额度耗尽或凭据失效时，请求会在产出任何内容之前静默换到下一个可用 Key。',
      activeBadge: '使用中',
      idleBadge: '空闲',
      exhaustedBadge: '额度耗尽',
      invalidBadge: '已失效',
      disabledBadge: '已停用',
      rolling: '5 小时滚动',
      weekly: '每周',
      monthly: '每月',
      used: '已用',
      left: '剩余',
      resetsIn: '重置',
      unknown: '未知',
      credentialRef: '凭据引用',
      credentialMissing: '未配置凭据',
      noApiKey: '未配置凭据，等待填写',
      unauthorized: 'Key 无效或已过期（401）',
      network: '网络请求失败',
      badJson: '接口响应解析失败',
      httpError: '接口返回 HTTP {status}',
      switchNow: '立即切换',
      disable: '停用',
      enable: '启用',
      clearInvalid: '清除失效',
      clearExhausted: '清除耗尽',
      lastSwitch: '最近切换',
      switchQuota: '额度耗尽',
      switchConsecutive: '连续失败',
      switchInvalid: '凭据失效',
      switchManual: '手动',
      lastFailure: '最近失败',
      usableCount: '可用 {n} 个',
      noKeysTitle: '尚未配置 Key',
      noKeysHint: '每个 Key 对应一个 OpenCode Go 账号。在下方「Key 管理」中添加：显示名自己起，密钥直接粘贴，凭据引用名留空会自动生成。',
      confirmSwitch: '立即切换到该 Key？',
      confirmDisable: '停用该 Key？停用后不再参与自动切换。',
      confirmClear: '清除失效标记？请确认已在凭据中修复该 Key。',
      confirmClearExhausted: '清除额度耗尽标记？该 Key 会立即回到轮换中。',

      // ── Key 管理 ──────────────────────────────────────────────
      manageTitle: 'Key 管理',
      manageHint: 'id 自动生成；label 为显示名；密钥直接粘贴（留空则不修改）；凭据引用名留空会自动生成。',
      addKey: '添加 Key',
      remove: '删除',
      save: '保存',
      discard: '放弃修改',
      saved: '已保存',
      saveFailed: '保存失败',
      labelPlaceholder: '显示名，如 主号',
      envPlaceholder: '引用名，留空自动生成（如 OPENCODE_GO_KEY_A）',
      secretPlaceholder: '粘贴 sk-... 密钥（留空则不修改）',
      envInvalidHint: '引用名不是密钥！密钥请粘贴到第三个「密钥」栏；引用名留空即可自动生成',
      existingRowTag: '已有',
      newRowTag: '新增',
      confirmRemoveExisting: '以下已有 Key 将从池中移除：',

      // ── 切号策略 ──────────────────────────────────────────────
      strategyTitle: '切号策略',
      strategyHint: '避让：5 小时滚动窗口或每周窗口任一达到阈值即提前切走（100=仅失败时切）；连败：模型调用失败累计 N 次切号（0=关闭）。额度耗尽或凭据失效始终立即切换。',
      preemptLead: '5h/每周用量达到',
      preemptUnit: '% 自动避让',
      consecLead: '连续失败',
      consecUnit: '次切号',
      preemptLabel: '5 小时用量达到 % 自动切号（100=仅失败时切）',
      consecLabel: '连续失败次数达到后自动切号（0=关闭）',
      preemptNote: '预切换阈值',
      preemptOff: '失败才切',
      consecNote: '连败切号',
      perKey: '每 Key',

      // ── 模型选择（Go 档） ─────────────────────────────────────
      modelTitle: 'Go 档模型选择',
      modelHint: '控制哪些模型出现在对话的模型下拉里；未勾选的模型不可发起请求。「全部模型」始终跟随官方目录，新模型自动可用。',
      allModels: '全部模型（跟随官方目录）',
      modelCount: '已启用 {n} 个模型',
      modelNone: '未选择任何模型：该供应商暂时不可用',
      modelUnavailable: '模型目录暂不可用，稍后刷新重试',
      modelEmptyHint: '自定义选择至少需要勾选一个模型',
      modelFetch: '拉取模型',
      modelFetching: '拉取中…',
      modelFetched: '已获取 {count} 个模型，新增 {added} 个',
      modelFetchFailed: '拉取模型失败',
      modelFetchHint: '从官方 models 接口拉取最新模型；目录里还没有的新模型按默认协议接入（思考强度与 DeepSeek V4 一致），勾选后即可尝试使用',
      modelExpand: '展开',
      modelCollapse: '收起',
      dynamicTag: '动态',
      imageCapable: '图片',
      modelImageCount: '图片 {n}',
      modelImageHint: '勾选「图片」即向 Harness 声明该模型接受 image 输入（read_image、对话贴图才会放行）；官方目录没声明图片的模型默认只有 text。只写入目录没声明的部分，保存后立即生效。',
      modelImageCatalogHint: '官方目录已声明该模型接受图片输入，这里只作展示。',

      // ── 容量 ──────────────────────────────────────────────────
      capacityTitle: '上下文容量',
      capacityHint: '模型列表接口只公布 id，不公布容量。动态接入的模型使用文档默认值（128k 上下文 / 32k 输出），在这里填真实数值即生效；官方目录自己的模型以目录为准，不可覆盖。',
      capacityAssumed: '默认值',
      capacityConfigured: '已修正',
      capacityCatalog: '目录值',
      capacityNone: '未知',
      capacityContext: '上下文',
      capacityMaxTokens: '输出上限',
      capacityInvalid: '容量必须是正整数',
      capacitySourceCol: '来源',

      // ── 免费档 ────────────────────────────────────────────────
      freeTitle: '免费档模型',
      freeHint: '免费档路由 opencode 由 llm-pi-ai 持有，本插件只通过 settings 缝隙读写它的模型列表：勾选线上有、配置里没有的模型即可加入；取消勾选即从配置里移除。',
      freeRoute: '路由',
      freeMissing: '免费档路由尚未配置（settings 的 llm-pi-ai.providers.opencode 不存在）',
      freeConfigured: '已配置 {n} 个',
      freeLive: '线上 {n} 个',
      freeAdded: '可上架 {n}',
      freeStale: '已下架',
      freeApply: '写入所选',
      freeNothing: '免费档模型列表为空，至少保留一个模型',
      freeRevision: '配置修订号',
      freeEmpty: '暂无数据，先刷新',
      freeFetch: '重新拉取',
      freeSelectAll: '全选线上',
      freeSelectNone: '清空所选',
      freeReadOnly: 'settings 提供方只读，无法写入。',
      freeWriteFailed: '写入失败',
      freeWritten: '已写入 settings.yaml，下一次请求生效（共 {n} 个模型）。',
      freeDelistedHint: '这些模型已从线上目录下架，仍在配置中；建议取消勾选后写入。',

      // ── 会话标识 ──────────────────────────────────────────────
      sessionTitle: '会话标识（session headers）',
      sessionHint: '把 Harness 的会话 id 挂到发往 opencode 的 HTTP 请求头上（默认 x-opencode-session 及同族的亲和头），让网关按会话做粘滞与统计。只改请求头，不改请求体。',
      sessionEnabled: '启用会话头注入',
      sessionDisabledHint: '已关闭：请求按原样发出。',
      sessionNanoid: '会话 id 哈希化（nanoid）',
      sessionNanoidHint: '把会话 id 摘要成固定长度短码再发出去，避免把完整 id 暴露给网关；关闭则原样发送。',
      sessionNanoidLength: '短码长度',
      sessionNanoidAlphabet: '字符集',
      sessionAlphabetAlnum: '字母数字',
      sessionAlphabetUrl: 'URL 安全',
      sessionSeed: '缺失时补齐（seed）',
      sessionSeedHint: '会话没有 id 时生成一个并沿用，保证同一会话始终同一标识。',
      sessionVerbose: '记录注入日志',
      sessionVerboseHint: '把每次注入的 URL / 头名 / 会话短码留在内存里（最多 20 条），供下方诊断区查看；不记录任何密钥。',
      sessionProviders: '匹配的路由',
      sessionProvidersHint: '逗号分隔的 llm-pi-ai 路由名；只有这些路由发起的请求会被处理。',
      sessionHosts: '匹配的主机',
      sessionHostsHint: '逗号分隔的 URL 主机名后缀。',
      sessionHeaders: '注入的头',
      sessionHeadersHint: '逗号分隔的头名；留空则回落到默认四件套。',
      sessionExtraHeaders: '额外固定头',
      sessionExtraHeadersHint: '每行一条，形如 name: value。值里不要放密钥。',
      sessionUserAgent: 'User-Agent 覆盖',
      sessionUserAgentHint: '留空则不改动原始 User-Agent。',
      sessionInjected: '已注入 {n} 次',
      sessionRecent: '最近注入',
      sessionNone: '暂无记录',
      sessionClear: '清空日志',
      sessionCleared: '日志已清空',
      sessionTime: '时间',
      sessionUrl: 'URL',
      sessionHeadersCol: '头',
      sessionIdCol: '会话 id',
      sessionTokenCol: '发出的短码',
      sessionErrorCol: '错误',
      sessionListInvalid: '列表项必须是非空字符串，用逗号分隔',
      sessionLengthInvalid: '短码长度必须是 4 到 32 的整数',
      sessionExtraInvalid: '额外固定头必须是 name: value 形式',
      sessionEnvNote: '构建期配置项（sessionIdEnv、注入开关等）只读，不在本页修改。',

      // ── 本地用量（按天 × 模型） ────────────────────────────────
      usageTitle: '本地用量（按天 × 模型）',
      usageHint: '从本机会话日志折叠出来的 token 统计。Go 用量端点只按 Key 给出「额度窗口用了百分之多少」，既没有 token 数也没有模型拆分，所以「哪个模型费额度」只能从这里回答。',
      usageEnable: '统计本地用量',
      usageDisabled: '已关闭：卡片不读会话日志，oc_usage_models 工具也返回空。打开后立刻开始统计已有日志。',
      usageWindow: '统计窗口',
      usageDay1: '今天',
      usageDay7: '近 7 天',
      usageDay30: '近 30 天',
      usageDay90: '近 90 天',
      usageCalls: '调用',
      usageInput: '输入',
      usageCache: '缓存读',
      usageOutput: '输出',
      usageTotal: '合计',
      usageShare: '占比',
      usageModelCol: '模型',
      usageDateCol: '日期',
      usageCacheShare: '缓存读占全部 token 的 {pct}。订阅制下烧掉窗口的是这一块，不是输出量。',
      usageEmpty: '这个窗口里没有任何模型调用。',
      usageEmptyHint: '新 profile、或窗口早于第一次调用时就是这样。发一次消息再点刷新就有了。',
      usageSource: '数据来源',
      dockNews: '新模型 {n}',
      dockNewsHint: '点击暂时不再提示；上架 / 拉取在「设置 → OpenCode 套件」里做',
      dockUsage: '今日 {tokens} tok',
      dockUsageHint: '本机按天统计的 token 用量（{calls} 次调用）',
      dockSourceLive: '实时',
      dockSourceLog: '会话日志',
      dockFailed: '统计读取失败',
      imTitle: 'IM 推送',
      imHint: '发现新模型时，用 IM 插件已配好的投递目标主动发一条消息。机器人和目标在「设置 → IM 机器人」里建，本页只负责选。',
      imEnable: '推送上新消息',
      imBot: '机器人',
      imTarget: '投递目标',
      imNone: '没有可选的机器人',
      imTest: '发条测试',
      imTesting: '发送中…',
      imSent: '已发出',
      imFailed: '发送失败：{error}',
      imLastResult: '上次结果：{result}',
      newsTitle: '模型上新提醒',
      newsHint: '后台每 {minutes} 分钟核对一次两档线上列表。下面是还没处理的变动。',
      newsNew: '新上线',
      newsGone: '已下架',
      newsSince: '首次发现 {when}',
      newsNone: '没有待处理的变动。',
      newsFetchGo: '拉取到 Go 档',
      newsAdoptFree: '上架到免费档',
      newsDismiss: '知道了',
      newsCheck: '立即核对',
      newsChecked: '核对于 {when}',
      newsOff: '已关闭：不后台核对，列表变化只在你打开本页时显示。',
      newsFailed: '核对失败：{error}',
      usageSourcePickLive: '实时',
      usageSourcePickLog: '会话日志',
      usageSourceLive: '实时（统计本进程流过的请求）',
      usageSourceLog: '会话日志（含启用前的历史）',
      usageSourceLiveEmpty: '启用后还没有走过模型请求。发一条消息，再点重试。',
      usageSourceLogEmpty: '这个窗口里没有模型调用。发一条消息，或换更长的窗口再看。',
      usageSweep: '已扫描 {sessions} 个会话，本次折叠 {processed} 个，{failed} 个读不了。',
      usageSweepPending: '还有 {pending} 个会话排队，每刷新一次扫一批。',
      usageUpdated: '统计于',
      usageFailed: '读取会话日志失败：{error}',
    }

    const en = {
      nav: 'OpenCode Suite',
      title: 'OpenCode Suite',
      subtitle: 'key pool · both model tiers · session identity, one page',
      loading: 'Loading…',
      loadFailed: 'Failed to load',
      paused: 'repeated failures, auto-refresh paused',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      updatedAt: 'updated',
      actionFailed: 'Action failed',
      yes: 'OK',
      cancel: 'Cancel',

      takeoverServing: 'Serving · opencode-go route taken over',
      takeoverOwnRoute: 'Own route mode · opencode-suite-go',
      takeoverWaiting: 'Waiting for takeover',
      takeoverWaitingHint: 'The opencode-go route is currently owned by another plugin. Remove the opencode-go row under Settings → Models and this plugin takes over automatically — existing conversations keep working unchanged.',

      poolTitle: 'Key pool',
      poolHint: 'Each key is one OpenCode Go account. On quota exhaustion or an invalid credential the request silently moves to the next usable key before any content is produced.',
      activeBadge: 'in use',
      idleBadge: 'idle',
      exhaustedBadge: 'quota exhausted',
      invalidBadge: 'invalid',
      disabledBadge: 'disabled',
      rolling: '5h rolling',
      weekly: 'Weekly',
      monthly: 'Monthly',
      used: 'used',
      left: 'left',
      resetsIn: 'resets',
      unknown: 'unknown',
      credentialRef: 'credential ref',
      credentialMissing: 'no credential',
      noApiKey: 'credential not set yet',
      unauthorized: 'key rejected (401)',
      network: 'network request failed',
      badJson: 'bad JSON from the usage endpoint',
      httpError: 'usage endpoint answered HTTP {status}',
      switchNow: 'Switch now',
      disable: 'Disable',
      enable: 'Enable',
      clearInvalid: 'Clear invalid',
      clearExhausted: 'Clear exhausted',
      lastSwitch: 'last switch',
      switchQuota: 'quota',
      switchConsecutive: 'consecutive failures',
      switchInvalid: 'credential',
      switchManual: 'manual',
      lastFailure: 'last failure',
      usableCount: '{n} usable',
      noKeysTitle: 'No keys configured',
      noKeysHint: 'Each key is one OpenCode Go account. Add keys under “Key management” below: pick a display name, paste the secret, and leave the ref name empty to auto-generate it.',
      confirmSwitch: 'Switch to this key now?',
      confirmDisable: 'Disable this key? It stops taking part in failover.',
      confirmClear: 'Clear the invalid mark? Make sure the credential is fixed first.',
      confirmClearExhausted: 'Clear the exhausted mark? The key returns to the rotation immediately.',

      manageTitle: 'Key management',
      manageHint: 'id is auto-generated; label is the display name; paste the secret directly (empty = keep); the credential ref auto-generates when left empty.',
      addKey: 'Add key',
      remove: 'Remove',
      save: 'Save',
      discard: 'Discard',
      saved: 'Saved',
      saveFailed: 'Save failed',
      labelPlaceholder: 'display name, e.g. main',
      envPlaceholder: 'ref name, auto when empty (e.g. OPENCODE_GO_KEY_A)',
      secretPlaceholder: 'paste the sk-... secret (empty = keep)',
      envInvalidHint: 'the ref name is not the secret! Paste the secret into the third field, or leave the ref name empty to auto-generate',
      existingRowTag: 'existing',
      newRowTag: 'new',
      confirmRemoveExisting: 'These existing keys will be removed from the pool:',

      strategyTitle: 'Switching strategy',
      strategyHint: 'Avoid: switch ahead once the 5h rolling OR weekly window reaches the threshold (100=fail-only). Consecutive: switch after N accumulated call failures (0=off). Quota exhaustion or an invalid credential always switches immediately.',
      preemptLead: 'Auto-avoid at',
      preemptUnit: '% 5h/weekly usage',
      consecLead: 'switch after',
      consecUnit: 'consecutive failures',
      preemptLabel: 'Auto-switch at 5h usage % (100=fail-only)',
      consecLabel: 'Switch after N consecutive failures (0=off)',
      preemptNote: 'preempt threshold',
      preemptOff: 'fail-only',
      consecNote: 'consec. failures',
      perKey: 'per key',

      modelTitle: 'Go tier model selection',
      modelHint: 'Controls which models appear in the chat model dropdown; unchecked models cannot be used. “All models” always follows the official catalog — new models become available automatically.',
      allModels: 'All models (follow the catalog)',
      modelCount: '{n} models enabled',
      modelNone: 'No model selected: the provider is temporarily unusable',
      modelUnavailable: 'Model catalog unavailable — try refreshing later',
      modelEmptyHint: 'Custom selection needs at least one model',
      modelFetch: 'Fetch models',
      modelFetching: 'Fetching…',
      modelFetched: 'Fetched {count} models, {added} new',
      modelFetchFailed: 'Failed to fetch models',
      modelFetchHint: 'Pull the latest models from the official models endpoint; new models are wired up with a default protocol (thinking levels like DeepSeek V4) and become usable once checked',
      modelExpand: 'Expand',
      modelCollapse: 'Collapse',
      dynamicTag: 'dynamic',
      imageCapable: 'Image',
      modelImageCount: 'image {n}',
      modelImageHint: 'Checking “Image” declares image input for that model, which is what admits read_image and pasted images; models the official catalog does not declare stay text-only. Only what the catalog does not declare is written, and a save applies immediately.',
      modelImageCatalogHint: 'The official catalog already declares image input for this model; the checkbox only reports it.',

      capacityTitle: 'Context capacities',
      capacityHint: 'The models endpoint discloses ids only, never capacities. Dynamically adopted models ride the documented defaults (128k context / 32k output); filling in the real numbers here makes them effective. A model the official catalog already describes keeps the catalog’s numbers.',
      capacityAssumed: 'default',
      capacityConfigured: 'corrected',
      capacityCatalog: 'catalog',
      capacityNone: 'unknown',
      capacityContext: 'context',
      capacityMaxTokens: 'max output',
      capacityInvalid: 'capacities must be positive integers',
      capacitySourceCol: 'source',

      freeTitle: 'Free tier models',
      freeHint: 'The free route opencode belongs to llm-pi-ai; this plugin only reads and writes its model list through the settings seam. Check an online model that is not configured to add it; uncheck a configured one to drop it.',
      freeRoute: 'route',
      freeMissing: 'The free route is not configured yet (llm-pi-ai.providers.opencode is absent)',
      freeConfigured: '{n} configured',
      freeLive: '{n} online',
      freeAdded: '{n} adoptable',
      freeStale: 'delisted',
      freeApply: 'Write selection',
      freeNothing: 'The free-tier model list would be empty — keep at least one model',
      freeRevision: 'settings revision',
      freeEmpty: 'No data yet — refresh first',
      freeFetch: 'Re-fetch',
      freeSelectAll: 'Select all online',
      freeSelectNone: 'Clear selection',
      freeReadOnly: 'The settings provider is read-only; writing is disabled.',
      freeWriteFailed: 'Write failed',
      freeWritten: 'Written to settings.yaml; effective on the next request ({n} models).',
      freeDelistedHint: 'These models are gone from the online catalog but still configured; uncheck them and write.',

      sessionTitle: 'Session identity (headers)',
      sessionHint: 'Attaches the harness session id to the HTTP requests sent to opencode (x-opencode-session plus the affinity family by default), so the gateway can stick and attribute by session. Request headers only — the body is untouched.',
      sessionEnabled: 'Inject session headers',
      sessionDisabledHint: 'Off: requests go out unchanged.',
      sessionNanoid: 'Hash the session id (nanoid)',
      sessionNanoidHint: 'Sends a fixed-length digest of the session id instead of the id itself, so the gateway never sees the full identifier.',
      sessionNanoidLength: 'Digest length',
      sessionNanoidAlphabet: 'Alphabet',
      sessionAlphabetAlnum: 'alphanumeric',
      sessionAlphabetUrl: 'URL-safe',
      sessionSeed: 'Seed when absent',
      sessionSeedHint: 'Generate an id when the session has none and reuse it, so one conversation keeps one identifier.',
      sessionVerbose: 'Record the injection log',
      sessionVerboseHint: 'Keeps the URL, header names and session digest of each injection in memory (20 max) for the diagnostics table below. No secrets are recorded.',
      sessionProviders: 'Matched routes',
      sessionProvidersHint: 'Comma-separated llm-pi-ai route names; only requests from these routes are handled.',
      sessionHosts: 'Matched hosts',
      sessionHostsHint: 'Comma-separated URL host suffixes.',
      sessionHeaders: 'Injected headers',
      sessionHeadersHint: 'Comma-separated header names; empty falls back to the default four.',
      sessionExtraHeaders: 'Extra fixed headers',
      sessionExtraHeadersHint: 'One per line, as name: value. Never put a secret in a value.',
      sessionUserAgent: 'User-Agent override',
      sessionUserAgentHint: 'Empty leaves the original User-Agent untouched.',
      sessionInjected: '{n} injected',
      sessionRecent: 'Recent injections',
      sessionNone: 'No records yet',
      sessionClear: 'Clear log',
      sessionCleared: 'Log cleared',
      sessionTime: 'time',
      sessionUrl: 'URL',
      sessionHeadersCol: 'headers',
      sessionIdCol: 'session id',
      sessionTokenCol: 'sent digest',
      sessionErrorCol: 'error',
      sessionListInvalid: 'list items must be non-empty strings, comma-separated',
      sessionLengthInvalid: 'digest length must be an integer 4..32',
      sessionExtraInvalid: 'extra fixed headers must be name: value lines',
      sessionEnvNote: 'Build-time settings (sessionIdEnv, the injection switch, …) are read-only and not edited here.',

      // ── Local usage (day × model) ──────────────────────────────
      usageTitle: 'Local usage (day × model)',
      usageHint: 'Token totals folded from this host\'s session log. The Go usage endpoint reports only how much of each plan window a KEY has spent — no token counts, no model split — so "which model burns the window" can only be answered here.',
      usageEnable: 'Account local usage',
      usageDisabled: 'Off: the card does not read the session log and oc_usage_models returns nothing. Turning it on accounts the logs already on disk.',
      usageWindow: 'Window',
      usageDay1: 'Today',
      usageDay7: '7 days',
      usageDay30: '30 days',
      usageDay90: '90 days',
      usageCalls: 'calls',
      usageInput: 'input',
      usageCache: 'cache read',
      usageOutput: 'output',
      usageTotal: 'total',
      usageShare: 'share',
      usageModelCol: 'model',
      usageDateCol: 'date',
      usageCacheShare: 'Cache reads are {pct} of every token in this window. On a subscription that share, not output volume, is what burns the window.',
      usageEmpty: 'No model calls in this window.',
      usageEmptyHint: 'That is what a fresh profile, or a window that predates the first call, looks like. Send a message and refresh.',
      usageSource: 'Source',
      dockNews: '{n} new',
      dockNewsHint: 'Click to stop the nudge here; adopting them lives in Settings → OpenCode Suite',
      dockUsage: '{tokens} tok today',
      dockUsageHint: 'Tokens this host spent today ({calls} calls)',
      dockSourceLive: 'live',
      dockSourceLog: 'session log',
      dockFailed: 'usage unavailable',
      imTitle: 'IM push',
      imHint: 'Sends one message over a delivery target dsh-im already has when a new model appears. Bots and targets are created in Settings → IM 机器人; this page only picks one.',
      imEnable: 'Push new-model news',
      imBot: 'Bot',
      imTarget: 'Target',
      imNone: 'No bot to choose from',
      imTest: 'Send a test',
      imTesting: 'Sending…',
      imSent: 'Sent',
      imFailed: 'Send failed: {error}',
      imLastResult: 'Last result: {result}',
      newsTitle: 'New models',
      newsHint: 'Both tiers\' online listings are checked every {minutes} minutes in the background. Here is what is still unhandled.',
      newsNew: 'new online',
      newsGone: 'delisted',
      newsSince: 'first seen {when}',
      newsNone: 'Nothing unhandled.',
      newsFetchGo: 'Fetch into the Go tier',
      newsAdoptFree: 'Adopt into the free tier',
      newsDismiss: 'Dismiss',
      newsCheck: 'Check now',
      newsChecked: 'checked {when}',
      newsOff: 'Off: no background check, so listing changes only show while this page is open.',
      newsFailed: 'Check failed: {error}',
      usageSourcePickLive: 'live',
      usageSourcePickLog: 'log',
      usageSourceLive: 'live (what this host streamed)',
      usageSourceLog: 'session log (includes history from before it was on)',
      usageSourceLiveEmpty: 'No model request has gone through yet. Send one, then retry.',
      usageSourceLogEmpty: 'No model call in this window. Send one, or widen the window.',
      usageSweep: 'Scanned {sessions} sessions, folded {processed} this sweep, {failed} unreadable.',
      usageSweepPending: '{pending} sessions still queued; each refresh folds one batch.',
      usageUpdated: 'accounted at',
      usageFailed: 'Reading the session log failed: {error}',
    }

    /* ------------------------------------------------------------------ *
     * Remote contribution
     * ------------------------------------------------------------------ */

    // The result codecs are pass-through parsers: the Host validates business
    // results against its own zod schemas before they cross the wire; this side
    // only needs the descriptor shapes to mount and call. Every codec must be
    // strict — the generated client Remote binder rejects src-json results at
    // mount time ("has no strict codec").
    const passthrough = () => ({ parse(value) { return value } })
    // 0.1.7 起 strict codec 是「工厂」：create() 必须返回 schema 本体
    // （客户端注册表用 `record.value ??= record.create()` 取它再做校验），
    // 只带 schema 的旧形状会被判 `has no create() factory` 并抛出，
    // 使 $mount 的 promise 永远不 resolve、页面卡在「加载失败」。
    const strict = () => ({ mode: 'strict', typeSymbol: 'json', create: () => passthrough(), schema: passthrough() })
    const DESCRIPTOR = (method, parameters) => ({
      id: `dsh-opencode-suite#opencodeSuite/${method}`,
      service: 'opencodeSuite',
      namespace: 'opencodeSuite',
      method,
      invocation: { kind: 'direct' },
      parameters: parameters.map(p => ({
        name: p,
        wire: p,
        source: 'json',
        codec: { mode: 'strict', typeSymbol: 'json', create: () => passthrough(), schema: passthrough() },
      })),
      result: strict(),
    })

    // Kept in lockstep with typert.host.js — a method that exists there but not
    // here is simply unreachable from the page, and a descriptor here without a
    // host invocation fails at call time.
    const TYPERT_REMOTE = {
      package: 'dsh-opencode-suite',
      descriptors: [
        DESCRIPTOR('status', []),
        DESCRIPTOR('usageBreakdown', ['days']),
        DESCRIPTOR('imTargets', []),
        DESCRIPTOR('testImNotify', ['text']),
        DESCRIPTOR('checkModels', []),
        DESCRIPTOR('dismissModelNews', ['tier']),
        DESCRIPTOR('takeOverState', []),
        DESCRIPTOR('setActive', ['id']),
        DESCRIPTOR('setDisabled', ['id', 'on']),
        DESCRIPTOR('clearInvalid', ['id']),
        DESCRIPTOR('clearExhausted', ['id']),
        DESCRIPTOR('putKeys', ['keys']),
        DESCRIPTOR('putKeySecret', ['id', 'secret']),
        DESCRIPTOR('putConfig', ['config']),
        DESCRIPTOR('putSessionHeaders', ['patch']),
        DESCRIPTOR('clearSessionLog', []),
        DESCRIPTOR('refreshModels', []),
        DESCRIPTOR('freeTier', []),
        DESCRIPTOR('putFreeTierModels', ['entries', 'assumeDefaults']),
      ],
    }

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    const styles = {
      wrap: { maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 14, padding: '8px 0' },
      head: { display: 'flex', alignItems: 'center', gap: 10 },
      title: { fontSize: 16, fontWeight: 600, margin: 0 },
      subtitle: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: '2px 0 0' },
      sectionTitle: { fontSize: 13, fontWeight: 600, margin: 0, color: 'var(--dsw-alias-label-primary)' },
      hint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.6, margin: 0 },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13, lineHeight: 1.6, margin: 0 },
      banner: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 10, padding: '12px 14px', fontSize: 13, lineHeight: 1.6, display: 'flex', flexDirection: 'column', gap: 6 },
      bannerWarn: { borderColor: 'var(--dsw-alias-state-warning-primary, #d97706)', color: 'var(--dsw-alias-label-primary)' },
      bannerOk: { borderColor: 'var(--dsw-alias-state-business-primary)', color: 'var(--dsw-alias-label-primary)' },
      card: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 },
      cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      cardName: { fontSize: 14, fontWeight: 600, margin: 0 },
      cardMeta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: '2px 0 0', lineHeight: 1.6 },
      badges: { display: 'flex', gap: 6, flexWrap: 'wrap' },
      barRow: { display: 'flex', flexDirection: 'column', gap: 3 },
      barHead: { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', gap: 8 },
      barTrack: { height: 8, borderRadius: 4, background: 'var(--dsw-alias-bg-layer-1)', overflow: 'hidden' },
      barFill: { height: '100%', borderRadius: 4, background: 'var(--dsw-alias-state-business-primary)', transition: 'width .2s ease' },
      actions: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 2 },
      button: { border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', cursor: 'pointer', background: 'transparent', borderRadius: 6, padding: '5px 12px' },
      buttonPrimary: { border: '1px solid var(--dsw-alias-state-business-primary)', color: 'var(--dsw-alias-state-business-primary)' },
      buttonDanger: { border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' },
      buttonDisabled: { opacity: 0.45, cursor: 'not-allowed' },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: { flex: '1 1 160px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', borderRadius: 6, padding: '5px 10px', minWidth: 0 },
      textarea: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontFamily: 'inherit', borderRadius: 6, padding: '6px 10px', minHeight: 56, resize: 'vertical', width: '100%', boxSizing: 'border-box' },
      editorRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      editorId: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, minWidth: 150 },
      notice: { fontSize: 13, margin: 0 },
      noticeOk: { color: 'var(--dsw-alias-state-business-primary)' },
      noticeErr: { color: 'var(--dsw-alias-state-error-primary)' },
      badge: { fontSize: 11, borderRadius: 999, padding: '2px 9px', border: '1px solid transparent', whiteSpace: 'nowrap' },
      fieldRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--dsw-alias-label-secondary)', flexWrap: 'wrap' },
      check: { width: 15, height: 15, margin: 0, flex: 'none', cursor: 'pointer', accentColor: 'var(--dsw-alias-state-business-primary)' },
      smallInput: { width: 74, flex: 'none' },
      midInput: { width: 120, flex: 'none' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', color: 'var(--dsw-alias-label-tertiary)', fontWeight: 600, padding: '4px 8px 4px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' },
      td: { color: 'var(--dsw-alias-label-secondary)', padding: '4px 8px 4px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, var(--dsw-alias-border-l2))', verticalAlign: 'top', wordBreak: 'break-all' },
      tdNum: { color: 'var(--dsw-alias-label-secondary)', padding: '4px 8px 4px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, var(--dsw-alias-border-l2))', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      dayStrip: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 56 },
      dayCell: { display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 3, flex: 1, minWidth: 0 },
      dayBar: { width: '100%', borderRadius: 3, background: 'var(--dsw-alias-state-business-primary)', minHeight: 2 },
      dayBarEmpty: { width: '100%', borderRadius: 3, background: 'var(--dsw-alias-bg-layer-1)', minHeight: 2 },
      dayLabel: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
      shareCell: { display: 'flex', alignItems: 'center', gap: 6 },
      shareTrack: { width: 72, height: 6, borderRadius: 3, background: 'var(--dsw-alias-bg-layer-1)', overflow: 'hidden', flex: 'none' },
      shareFill: { height: '100%', borderRadius: 3, background: 'var(--dsw-alias-state-business-primary)' },
      divider: { height: 1, background: 'var(--dsw-alias-border-l2)', margin: '2px 0' },
      // The composer dock's own pill language, mirrored from the stats pills:
      // transparent at rest, hover surface on the button form, tertiary text.
      dockRoot: { display: 'inline-flex', gap: 12, minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)', lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))' },
      dockPill: { display: 'inline-flex', alignItems: 'center', gap: 6, boxSizing: 'border-box', maxWidth: '100%', padding: '1px 8px', border: 'none', borderRadius: 999, cornerShape: 'round', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', font: 'inherit', fontVariantNumeric: 'tabular-nums', lineHeight: 'inherit', whiteSpace: 'nowrap' },
      dockButton: { cursor: 'pointer' },
      dockButtonHover: { background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-secondary)' },
      dockDot: { width: 6, height: 6, borderRadius: 999, flex: 'none', background: 'var(--dsw-alias-state-business-primary)' },
    }

    const BADGE_TONE = {
      active: { bg: 'var(--dsw-alias-state-business-primary)', color: '#fff', text: t => t('activeBadge') },
      idle: { bg: 'transparent', color: 'var(--dsw-alias-label-secondary)', border: 'var(--dsw-alias-border-l2)', text: t => t('idleBadge') },
      exhausted: { bg: 'transparent', color: '#d97706', border: '#d97706', text: t => t('exhaustedBadge') },
      invalid: { bg: 'transparent', color: 'var(--dsw-alias-state-error-primary)', border: 'var(--dsw-alias-state-error-primary)', text: t => t('invalidBadge') },
      disabled: { bg: 'transparent', color: 'var(--dsw-alias-label-tertiary)', border: 'var(--dsw-alias-border-l2)', text: t => t('disabledBadge') },
    }

    /* ------------------------------------------------------------------ *
     * Helpers
     * ------------------------------------------------------------------ */

    // The typert client Remote wraps every result in an `{ ok, value }`
    // envelope (ok:false carries `error.message`); unwrap or throw so the UI
    // only ever sees business values.
    function unwrapRemote(result) {
      if (result && result.ok === false) {
        throw new Error((result.error && result.error.message) || 'remote failed')
      }
      return result && result.value !== undefined ? result.value : result
    }

    function badgeFor(state, active, t) {
      const kind = active && state === 'healthy' ? 'active'
        : state === 'exhausted' ? 'exhausted'
          : state === 'invalid' ? 'invalid'
            : state === 'disabled' ? 'disabled'
              : 'idle'
      const tone = BADGE_TONE[kind]
      return React.createElement('span', {
        style: { ...styles.badge, background: tone.bg, color: tone.color, borderColor: tone.border },
      }, tone.text(t))
    }

    function fmtReset(resetsAt, t, tick) {
      if (!resetsAt) return t('unknown')
      const target = new Date(resetsAt).getTime()
      if (Number.isNaN(target)) return resetsAt
      const diff = target - tick
      if (diff <= 0) return t('unknown')
      const totalMin = Math.floor(diff / 60000)
      if (totalMin < 60 * 24) {
        const h = Math.floor(totalMin / 60)
        const m = totalMin % 60
        return h > 0 ? `${h}h ${m}m` : `${m}m`
      }
      return new Date(resetsAt).toLocaleString()
    }

    function barColor(percent) {
      if (percent === null || percent === undefined) return 'var(--dsw-alias-state-business-primary)'
      if (percent >= 100) return 'var(--dsw-alias-state-error-primary)'
      if (percent >= 90) return '#d97706'
      return 'var(--dsw-alias-state-business-primary)'
    }

    function fmtNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value >= 1000000) return `${Math.round(value / 1000) / 1000}M`
      if (value >= 1000) return `${Math.round(value / 1000)}k`
      return String(value)
    }

    function usageErrorText(code, t) {
      if (code === 'no-api-key') return t('noApiKey')
      if (code === 'unauthorized') return t('unauthorized')
      if (code === 'network') return t('network')
      if (code === 'bad-json') return t('badJson')
      if (code && code.startsWith('http-')) return t('httpError').replace('{status}', code.slice(5))
      return t('unknown')
    }

    function switchReasonText(reason, t) {
      if (reason === 'quota') return t('switchQuota')
      if (reason === 'invalid') return t('switchInvalid')
      if (reason === 'consecutive') return t('switchConsecutive')
      return t('switchManual')
    }

    /** Comma/space separated text → a de-duplicated list of non-empty strings. */
    function parseList(text) {
      return [...new Set(String(text === undefined || text === null ? '' : text)
        .split(/[\s,]+/)
        .map(part => part.trim())
        .filter(part => part.length > 0))]
    }

    function formatList(list) {
      return (Array.isArray(list) ? list : []).join(', ')
    }

    /**
     * `name: value` lines → a header map. Blank lines and `#` comments are
     * skipped, and a line without a colon is dropped rather than guessed at.
     */
    function parseHeaderLines(text) {
      const out = {}
      for (const raw of String(text === undefined || text === null ? '' : text).split(/\r?\n/)) {
        const line = raw.trim()
        if (line.length === 0 || line.startsWith('#')) continue
        const at = line.indexOf(':')
        if (at <= 0) continue
        const name = line.slice(0, at).trim()
        const value = line.slice(at + 1).trim()
        if (name.length > 0) out[name] = value
      }
      return out
    }

    function formatHeaderLines(dict) {
      return Object.entries(dict || {}).map(([name, value]) => `${name}: ${value}`).join('\n')
    }

    /**
     * The `imageModels` list for the checkbox state: only the ids the shipped
     * catalog does not already declare image-capable (`catalogInputs`), so the
     * declaration never restates an answer the catalog owns.
     */
    function imageModelsPatch(available, images) {
      const wanted = new Set(images)
      return available
        .filter(m => wanted.has(m.id) && !(Array.isArray(m.catalogInputs) && m.catalogInputs.includes('image')))
        .map(m => m.id)
    }

    /**
     * Capacities are only editable where this plugin owns the number: a
     * fetched model riding the documented default ('default') or one already
     * corrected ('configured'). A shipped catalog descriptor always wins, so
     * its row is read-only.
     */
    function capacityEditable(row) {
      return !!(row && (row.capacitySource === 'default' || row.capacitySource === 'configured'))
    }

    /** Editable-capacity draft for every row, seeded from the live numbers. */
    function capacityDraft(available, overrides) {
      const out = {}
      for (const row of available || []) {
        if (!capacityEditable(row)) continue
        const fixed = overrides && overrides[row.id]
        out[row.id] = {
          contextWindow: String((fixed && fixed.contextWindow) ?? row.contextWindow ?? ''),
          maxTokens: String((fixed && fixed.maxTokens) ?? row.maxTokens ?? ''),
        }
      }
      return out
    }

    /**
     * The complete `modelCapacities` map for a save: everything already in
     * settings plus every editable row's current draft. The host replaces the
     * whole dict, so a partial patch would drop the other rows.
     * @returns {{ ok: true, value: object } | { ok: false, error: string }}
     */
    function buildCapacityPatch(existing, available, draft, t) {
      const next = {}
      for (const [id, value] of Object.entries(existing || {})) next[id] = { ...value }
      for (const row of available || []) {
        if (!capacityEditable(row)) continue
        const entry = (draft || {})[row.id]
        if (!entry) continue
        const contextWindow = Number(entry.contextWindow)
        const maxTokens = Number(entry.maxTokens)
        if (!Number.isInteger(contextWindow) || contextWindow < 1
            || !Number.isInteger(maxTokens) || maxTokens < 1) {
          return { ok: false, error: `${t('capacityInvalid')}: ${row.id}` }
        }
        next[row.id] = { contextWindow, maxTokens }
      }
      return { ok: true, value: next }
    }

    /**
     * The next free-tier model list from the checkbox state. Configured rows
     * keep their own name, capacities and modalities; an adopted row is sent as
     * a bare `{ id }` and the host fills the documented defaults in.
     */
    function buildFreeTierEntries(configured, selectedIds) {
      const wanted = new Set(selectedIds || [])
      const out = []
      for (const entry of configured || []) {
        if (!wanted.has(entry.id)) continue
        // An empty modality list would be read as "no input at all"; the host
        // normalizes it to text anyway, so state it here rather than relying on
        // the fallback.
        const input = Array.isArray(entry.input) && entry.input.length > 0 ? [...entry.input] : ['text']
        out.push({
          id: entry.id,
          name: entry.name || entry.id,
          contextWindow: entry.contextWindow,
          maxTokens: entry.maxTokens,
          input,
        })
      }
      const known = new Set((configured || []).map(entry => entry.id))
      for (const id of selectedIds || []) {
        if (!known.has(id)) out.push({ id })
      }
      return out
    }

    /* ------------------------------------------------------------------ *
     * Small presentational pieces
     * ------------------------------------------------------------------ */

    function UsageBar(props) {
      const { name, windowData, t, tick } = props
      const percent = windowData && typeof windowData.percent === 'number' ? windowData.percent : null
      const pct = percent === null ? 0 : Math.max(0, Math.min(100, percent))
      const left = percent === null ? t('unknown') : `${Math.max(0, 100 - percent)}%`
      const shown = percent === null ? t('unknown') : `${percent}%`
      return React.createElement('div', { style: styles.barRow },
        React.createElement('div', { style: styles.barHead },
          React.createElement('span', null, `${name} · ${t('used')} ${shown} / ${t('left')} ${left}`),
          React.createElement('span', null, `${t('resetsIn')}: ${fmtReset(windowData && windowData.resetsAt, t, tick)}`),
        ),
        React.createElement('div', { style: styles.barTrack },
          React.createElement('div', { style: { ...styles.barFill, width: pct + '%', background: barColor(percent) } }),
        ),
      )
    }

    function Checkbox(props) {
      const { checked, disabled, onChange, label, title, style } = props
      return React.createElement('label', {
        style: { display: 'flex', alignItems: 'center', gap: 6, cursor: disabled ? 'default' : 'pointer', ...style },
        title,
      },
        React.createElement('input', {
          type: 'checkbox',
          style: styles.check,
          checked: !!checked,
          disabled: !!disabled,
          onChange: () => onChange(!checked),
        }),
        label === undefined || label === null ? null : React.createElement('span', null, label),
      )
    }

    /**
     * Original "suite" mark: three chevrons stacked over one baseline, drawn in
     * the same 1.5px outline language as the settings icon set
     * (currentColor), plus the pool dot.
     */
    function SuiteMark(props) {
      const { size } = props
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', style: { display: 'block' },
      },
        React.createElement('path', { d: 'M10 2.6 L16.4 6.1 L10 9.6 L3.6 6.1 Z' }),
        React.createElement('path', { d: 'M3.6 10.2 L10 13.7 L16.4 10.2' }),
        React.createElement('path', { d: 'M3.6 13.9 L10 17.4 L16.4 13.9' }),
      )
    }

    /** The nav-row mark for this section, matched by CSS to hide the shell gear. */
    function NavMark(props) {
      const { className } = props
      return React.createElement('span', {
        className,
        style: { display: 'inline-flex', flex: 'none', marginRight: 8, verticalAlign: '-3px', color: 'inherit' },
      }, React.createElement(SuiteMark, { size: 15 }))
    }

    function navLabel(t) {
      return React.createElement(React.Fragment, null,
        React.createElement(NavMark, { className: 'dsh-ocs-nav-mark' }),
        React.createElement('span', null, t('nav')),
      )
    }

    function injectNavStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-ocs-nav-style')) return
      const style = document.createElement('style')
      style.id = 'dsh-ocs-nav-style'
      // Hide the shell's default gear icon on our nav row only.
      style.textContent = 'button:has(.dsh-ocs-nav-mark) > svg { display: none; }'
      document.head.appendChild(style)
    }

    /* ------------------------------------------------------------------ *
     * Key pool
     * ------------------------------------------------------------------ */

    function KeyCard(props) {
      const { item, t, tick, busy, onAction } = props
      const usage = item.usage || {}
      const disabled = busy !== null
      const isActive = item.active && item.state === 'healthy'
      const failure = item.lastFailure
      return React.createElement('div', { style: styles.card },
        React.createElement('div', { style: styles.cardHead },
          React.createElement('div', { style: { minWidth: 0 } },
            React.createElement('h3', { style: styles.cardName }, item.label),
            React.createElement('p', { style: styles.cardMeta },
              `${t('credentialRef')}: ${item.apiKeyEnv}${item.credentialSet === false ? ` (${t('credentialMissing')})` : ''}`),
          ),
          React.createElement('div', { style: styles.badges }, badgeFor(item.state, item.active, t)),
        ),
        item.usageError
          ? React.createElement('p', { style: styles.error }, usageErrorText(item.usageError, t))
          : React.createElement(React.Fragment, null,
            React.createElement(UsageBar, { name: t('rolling'), windowData: usage.rolling, t, tick }),
            React.createElement(UsageBar, { name: t('weekly'), windowData: usage.weekly, t, tick }),
            React.createElement(UsageBar, { name: t('monthly'), windowData: usage.monthly, t, tick }),
          ),
        failure
          ? React.createElement('p', { style: styles.hint },
              `${t('lastFailure')}: ${failure.code} — ${failure.message} @ ${new Date(failure.at).toLocaleString()}`)
          : null,
        React.createElement('div', { style: styles.actions },
          // Manual switch only makes sense on a usable key that is not already
          // active: the host refuses a disabled/exhausted/invalid target.
          item.state === 'healthy' && !isActive
            ? React.createElement('button', {
              style: { ...styles.button, ...styles.buttonPrimary, ...(disabled ? styles.buttonDisabled : {}) },
              disabled,
              onClick: () => onAction('setActive', item.id, t('confirmSwitch')),
            }, t('switchNow'))
            : null,
          item.state === 'disabled'
            ? React.createElement('button', {
              style: { ...styles.button, ...(disabled ? styles.buttonDisabled : {}) },
              disabled,
              onClick: () => onAction('setDisabled', item.id, null, false),
            }, t('enable'))
            : React.createElement('button', {
              style: { ...styles.button, ...(disabled ? styles.buttonDisabled : {}) },
              disabled,
              onClick: () => onAction('setDisabled', item.id, t('confirmDisable'), true),
            }, t('disable')),
          item.state === 'invalid'
            ? React.createElement('button', {
              style: { ...styles.button, ...(disabled ? styles.buttonDisabled : {}) },
              disabled,
              onClick: () => onAction('clearInvalid', item.id, t('confirmClear')),
            }, t('clearInvalid'))
            : null,
          item.state === 'exhausted'
            ? React.createElement('button', {
              style: { ...styles.button, ...(disabled ? styles.buttonDisabled : {}) },
              disabled,
              onClick: () => onAction('clearExhausted', item.id, t('confirmClearExhausted')),
            }, t('clearExhausted'))
            : null,
        ),
      )
    }

    function Editor(props) {
      const { draft, setDraft, t, busy, onSave, existingKeys } = props
      const existingIds = new Set((existingKeys || []).map(k => k.id))
      const update = (index, field, value) => {
        setDraft(prev => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
      }
      const remove = (index) => {
        setDraft(prev => prev.filter((_, i) => i !== index))
      }
      const add = () => {
        setDraft(prev => [...prev, { id: 'key-' + Date.now().toString(36), label: '', apiKeyEnv: '', secret: '' }])
      }
      const save = () => {
        const rows = draft.map(row => ({
          id: row.id,
          label: (row.label || '').trim(),
          apiKeyEnv: (row.apiKeyEnv || '').trim(),
          secret: (row.secret || '').trim(),
        }))
        for (const row of rows) {
          if (!row.label) { onSave(null, t('labelPlaceholder')); return }
          // The secret belongs in its own field; a reference name must look
          // like an environment variable. An empty one auto-generates.
          if (row.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.apiKeyEnv)) {
            onSave(null, t('envInvalidHint'))
            return
          }
        }
        // Deleting an already-saved key is destructive; confirm before wiping.
        const draftIds = new Set(rows.map(row => row.id))
        const removed = (existingKeys || []).filter(key => !draftIds.has(key.id))
        if (removed.length > 0
            && typeof window !== 'undefined' && typeof window.confirm === 'function'
            && !window.confirm(`${t('confirmRemoveExisting')}\n${removed.map(key => key.label).join(' / ')}`)) {
          return
        }
        onSave(rows)
      }
      return React.createElement('div', { style: styles.card },
        React.createElement('div', { style: styles.cardHead },
          React.createElement('div', { style: { minWidth: 0 } },
            React.createElement('h3', { style: styles.cardName }, t('manageTitle')),
            React.createElement('p', { style: styles.cardMeta }, t('manageHint')),
          ),
        ),
        draft.map((row, index) => React.createElement('div', { key: row.id, style: styles.editorRow },
          React.createElement('span', { style: styles.editorId },
            row.id,
            React.createElement('span', { style: { marginLeft: 6, opacity: 0.6, fontSize: 11 } },
              existingIds.has(row.id) ? t('existingRowTag') : t('newRowTag')),
          ),
          React.createElement('input', {
            style: styles.input,
            placeholder: t('labelPlaceholder'),
            value: row.label,
            disabled: busy !== null,
            onChange: event => update(index, 'label', event.target.value),
          }),
          React.createElement('input', {
            style: styles.input,
            placeholder: t('envPlaceholder'),
            value: row.apiKeyEnv,
            disabled: busy !== null,
            onChange: event => update(index, 'apiKeyEnv', event.target.value),
          }),
          React.createElement('input', {
            style: styles.input,
            type: 'password',
            autoComplete: 'off',
            placeholder: t('secretPlaceholder'),
            value: row.secret,
            disabled: busy !== null,
            onChange: event => update(index, 'secret', event.target.value),
          }),
          React.createElement('button', {
            style: { ...styles.button, ...styles.buttonDanger, ...(busy !== null ? styles.buttonDisabled : {}) },
            disabled: busy !== null,
            onClick: () => remove(index),
          }, t('remove')),
        )),
        React.createElement('div', { style: styles.actions },
          React.createElement('button', { style: styles.button, disabled: busy !== null, onClick: add }, t('addKey')),
          React.createElement('button', {
            style: { ...styles.button, ...styles.buttonPrimary, ...(busy !== null ? styles.buttonDisabled : {}) },
            disabled: busy !== null,
            onClick: save,
          }, t('save')),
          React.createElement('button', {
            style: { ...styles.button, ...(busy !== null ? styles.buttonDisabled : {}) },
            disabled: busy !== null,
            onClick: () => setDraft(null),
          }, t('discard')),
        ),
      )
    }

    /** Switching-strategy form: the two configurable auto-switch rules. */
    function StrategyCard(props) {
      const { t, data, strategy, setStrategy, busy, onSave } = props
      const value = strategy !== null
        ? strategy
        : {
            preempt: String(data.preemptAtPercent ?? 100),
            consec: String(data.switchAfterConsecutiveFailures ?? 0),
          }
      const update = (field, raw) => setStrategy({ ...value, [field]: raw })
      const save = () => {
        const preempt = Number(value.preempt)
        const consec = Number(value.consec)
        if (!Number.isFinite(preempt) || preempt < 0 || preempt > 100) { onSave(null, t('preemptLabel')); return }
        if (!Number.isFinite(consec) || consec < 0 || consec > 20) { onSave(null, t('consecLabel')); return }
        onSave({ preemptAtPercent: preempt, switchAfterConsecutiveFailures: consec })
      }
      return React.createElement('div', { style: styles.card },
        React.createElement('div', { style: styles.cardHead },
          React.createElement('div', { style: { minWidth: 0 } },
            React.createElement('h3', { style: styles.cardName }, t('strategyTitle')),
            React.createElement('p', { style: styles.cardMeta }, t('strategyHint')),
          ),
        ),
        React.createElement('div', { style: styles.fieldRow },
          React.createElement('span', null, t('preemptLead')),
          React.createElement('input', {
            style: { ...styles.input, ...styles.smallInput },
            value: value.preempt,
            disabled: busy !== null,
            onChange: event => update('preempt', event.target.value),
          }),
          React.createElement('span', null, t('preemptUnit')),
          React.createElement('span', null, t('consecLead')),
          React.createElement('input', {
            style: { ...styles.input, ...styles.smallInput },
            value: value.consec,
            disabled: busy !== null,
            onChange: event => update('consec', event.target.value),
          }),
          React.createElement('span', null, t('consecUnit')),
          React.createElement('button', {
            style: { ...styles.button, ...styles.buttonPrimary, ...(busy !== null ? styles.buttonDisabled : {}) },
            disabled: busy !== null,
            onClick: save,
          }, t('save')),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Go tier models + capacities
     * ------------------------------------------------------------------ */

    /**
     * Model selection for the pooled route, plus the capacity editor for the
     * models whose numbers this plugin owns. Collapsed by default so the key
     * pool below stays in view; expanding reveals the master "all models"
     * switch, the fetch action, per-model enable + image checkboxes, and the
     * capacity inputs.
     */
    function ModelCard(props) {
      const { t, data, sel, setSel, busy, onSave, onFetchModels, fetching, defaultOpen } = props
      const [open, setOpen] = React.useState(defaultOpen === true)
      const [capsOpen, setCapsOpen] = React.useState(false)
      const available = Array.isArray(data && data.availableModels) ? data.availableModels : []
      const imageIds = () => available
        .filter(m => Array.isArray(m.inputs) && m.inputs.includes('image'))
        .map(m => m.id)
      const value = sel !== null
        ? {
            mode: sel.mode,
            ids: sel.ids,
            images: Array.isArray(sel.images) ? sel.images : imageIds(),
            caps: sel.caps && typeof sel.caps === 'object' ? sel.caps : capacityDraft(available, data && data.modelCapacities),
          }
        : {
            mode: (data && data.modelMode) || 'all',
            ids: available.filter(m => m.enabled).map(m => m.id),
            images: imageIds(),
            caps: capacityDraft(available, data && data.modelCapacities),
          }
      const enabledCount = available.filter(m => value.mode === 'all' || value.ids.includes(m.id)).length
      const dynamicCount = available.filter(m => m.dynamic).length
      const imageCount = available.filter(m => value.images.includes(m.id)).length
      const editableRows = available.filter(capacityEditable)
      const assumedCount = editableRows.filter(m => m.capacitySource === 'default').length
      const counts = dynamicCount > 0
        ? `${t('modelCount').replace('{n}', String(enabledCount))} · ${t('dynamicTag')}${String(dynamicCount)}`
        : t('modelCount').replace('{n}', String(enabledCount))
      const badgeCounts = imageCount > 0
        ? `${counts} · ${t('modelImageCount').replace('{n}', String(imageCount))}`
        : counts
      const setCaps = (id, field, raw) => setSel({
        mode: value.mode,
        ids: value.ids,
        images: value.images,
        caps: { ...value.caps, [id]: { ...(value.caps[id] || {}), [field]: raw } },
      })
      const save = () => {
        if (value.mode === 'custom' && value.ids.length === 0) {
          onSave(null, t('modelEmptyHint'))
          return
        }
        const capacities = buildCapacityPatch(data && data.modelCapacities, available, value.caps, t)
        if (!capacities.ok) {
          setCapsOpen(true)
          onSave(null, capacities.error)
          return
        }
        onSave({
          modelMode: value.mode,
          models: value.mode === 'all' ? [] : value.ids,
          imageModels: imageModelsPatch(available, value.images),
          modelCapacities: capacities.value,
        })
      }
      const modelRow = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--dsw-alias-label-secondary)', flexWrap: 'wrap' }
      const sourceText = (row) => row.capacitySource === 'default' ? t('capacityAssumed')
        : row.capacitySource === 'configured' ? t('capacityConfigured')
          : row.capacitySource === 'catalog' ? t('capacityCatalog')
            : t('capacityNone')
      return React.createElement('div', { style: styles.card },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' } },
          React.createElement('div', { style: { minWidth: 0 } },
            React.createElement('h3', { style: styles.cardName }, t('modelTitle')),
            open ? React.createElement('p', { style: styles.cardMeta }, t('modelHint')) : null,
          ),
          React.createElement('div', { style: styles.actions },
            React.createElement('span', { style: { ...styles.badge, color: 'var(--dsw-alias-label-secondary)', borderColor: 'var(--dsw-alias-border-l2)' } }, badgeCounts),
            onFetchModels
              ? React.createElement('button', {
                style: { ...styles.button, ...(fetching || busy !== null ? styles.buttonDisabled : {}) },
                disabled: fetching || busy !== null,
                onClick: onFetchModels,
              }, fetching ? t('modelFetching') : t('modelFetch'))
              : null,
            React.createElement('button', { style: styles.button, onClick: () => setOpen(prev => !prev) },
              open ? t('modelCollapse') : t('modelExpand')),
          ),
        ),
        open
          ? React.createElement(React.Fragment, null,
            React.createElement('p', { style: styles.hint }, t('modelFetchHint')),
            React.createElement('p', { style: styles.hint }, t('modelImageHint')),
            available.length === 0
              ? React.createElement('p', { style: styles.hint }, t('modelUnavailable'))
              : React.createElement(React.Fragment, null,
                React.createElement(Checkbox, {
                  checked: value.mode === 'all',
                  disabled: busy !== null,
                  label: t('allModels'),
                  style: { ...modelRow, color: 'var(--dsw-alias-label-secondary)' },
                  onChange: (next) => setSel({
                    mode: next ? 'all' : 'custom',
                    ids: next ? available.map(m => m.id) : value.ids,
                    images: value.images,
                    caps: value.caps,
                  }),
                }),
                available.map(m => {
                  // A model the shipped catalog already declares image-capable
                  // owns that answer; the checkbox reports it and stays locked
                  // rather than pretending a removal would take effect.
                  const catalogImage = Array.isArray(m.catalogInputs) && m.catalogInputs.includes('image')
                  return React.createElement('div', {
                    key: m.id,
                    style: {
                      ...modelRow,
                      paddingLeft: 24,
                      justifyContent: 'space-between',
                      color: value.mode === 'all' ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-secondary)',
                    },
                  },
                    React.createElement('label', { style: { ...modelRow, flex: '1 1 auto', minWidth: 0, cursor: 'pointer' } },
                      React.createElement('input', {
                        type: 'checkbox',
                        style: styles.check,
                        checked: value.mode === 'all' || value.ids.includes(m.id),
                        disabled: busy !== null || value.mode === 'all',
                        onChange: () => {
                          const ids = value.ids.includes(m.id)
                            ? value.ids.filter(id => id !== m.id)
                            : [...value.ids, m.id]
                          setSel({ mode: 'custom', ids, images: value.images, caps: value.caps })
                        },
                      }),
                      React.createElement('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, m.name),
                      React.createElement('span', { style: { opacity: 0.65, fontSize: 12 } }, m.id),
                      m.dynamic ? React.createElement('span', {
                        style: {
                          fontSize: 10, borderRadius: 999, padding: '1px 7px',
                          color: 'var(--dsw-alias-state-warning-primary, #d97706)',
                          border: '1px solid var(--dsw-alias-state-warning-primary, #d97706)',
                          whiteSpace: 'nowrap',
                        },
                      }, t('dynamicTag')) : null,
                      React.createElement('span', { style: { opacity: 0.7, fontSize: 11 } },
                        `${fmtNumber(m.contextWindow)} / ${fmtNumber(m.maxTokens)}`),
                    ),
                    // Image capability is independent of the model selection:
                    // an unselected model keeps its declaration.
                    React.createElement(Checkbox, {
                      checked: catalogImage || value.images.includes(m.id),
                      disabled: busy !== null || catalogImage,
                      label: t('imageCapable'),
                      title: catalogImage ? t('modelImageCatalogHint') : t('modelImageHint'),
                      style: { gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', flex: 'none' },
                      onChange: (next) => {
                        const images = next
                          ? [...value.images.filter(id => id !== m.id), m.id]
                          : value.images.filter(id => id !== m.id)
                        setSel({ mode: value.mode, ids: value.ids, images, caps: value.caps })
                      },
                    }),
                  )
                }),
                enabledCount === 0
                  ? React.createElement('p', { style: styles.error }, t('modelNone'))
                  : null,
                React.createElement('div', { style: styles.actions },
                  React.createElement('button', {
                    style: { ...styles.button, ...styles.buttonPrimary, ...(busy !== null ? styles.buttonDisabled : {}) },
                    disabled: busy !== null,
                    onClick: save,
                  }, t('save')),
                  React.createElement('button', {
                    style: styles.button,
                    onClick: () => setCapsOpen(prev => !prev),
                  }, `${t('capacityTitle')}${assumedCount > 0 ? ` · ${t('capacityAssumed')} ${assumedCount}` : ''}`),
                  React.createElement('span', { style: { ...styles.badge, color: 'var(--dsw-alias-label-tertiary)', borderColor: 'var(--dsw-alias-border-l2)' } },
                    t('usableCount').replace('{n}', String(enabledCount))),
                ),
                capsOpen
                  ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    React.createElement('div', { style: styles.divider }),
                    React.createElement('p', { style: styles.hint }, t('capacityHint')),
                    editableRows.length === 0
                      ? React.createElement('p', { style: styles.hint }, t('capacityNone'))
                      : React.createElement('table', { style: styles.table },
                        React.createElement('thead', null,
                          React.createElement('tr', null,
                            React.createElement('th', { style: styles.th }, 'model'),
                            React.createElement('th', { style: styles.th }, t('capacitySourceCol')),
                            React.createElement('th', { style: styles.th }, t('capacityContext')),
                            React.createElement('th', { style: styles.th }, t('capacityMaxTokens')),
                          ),
                        ),
                        React.createElement('tbody', null,
                          editableRows.map(row => {
                            const entry = value.caps[row.id] || { contextWindow: '', maxTokens: '' }
                            return React.createElement('tr', { key: row.id },
                              React.createElement('td', { style: styles.td }, row.id),
                              React.createElement('td', { style: styles.td }, sourceText(row)),
                              React.createElement('td', { style: styles.td },
                                React.createElement('input', {
                                  style: { ...styles.input, ...styles.midInput },
                                  value: entry.contextWindow,
                                  disabled: busy !== null,
                                  onChange: event => setCaps(row.id, 'contextWindow', event.target.value),
                                })),
                              React.createElement('td', { style: styles.td },
                                React.createElement('input', {
                                  style: { ...styles.input, ...styles.midInput },
                                  value: entry.maxTokens,
                                  disabled: busy !== null,
                                  onChange: event => setCaps(row.id, 'maxTokens', event.target.value),
                                })),
                            )
                          }),
                        ),
                      ),
                    React.createElement('div', { style: styles.actions },
                      React.createElement('button', {
                        style: { ...styles.button, ...styles.buttonPrimary, ...(busy !== null ? styles.buttonDisabled : {}) },
                        disabled: busy !== null,
                        onClick: save,
                      }, t('save')),
                    ),
                  )
                  : null,
              ),
          )
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * Free tier
     * ------------------------------------------------------------------ */

    /**
     * The free route opencode is owned by llm-pi-ai; this plugin only mirrors
     * its model list through the settings seam. Rows already configured keep
     * their values; a checked online row is an adoption.
     */
    function FreeTierCard(props) {
      const { t, data, sel, setSel, busy, onApply, onFetch, fetching } = props
      const free = data || {}
      const configured = Array.isArray(free.configured) ? free.configured : []
      const live = Array.isArray(free.live) ? free.live : []
      const added = Array.isArray(free.added) ? free.added : []
      const stale = Array.isArray(free.stale) ? free.stale : []
      const configuredIds = configured.map(entry => entry.id)
      const selected = sel !== null ? sel : configuredIds
      const wanted = new Set(selected)
      const toggle = (id) => {
        const next = wanted.has(id) ? selected.filter(item => item !== id) : [...selected, id]
        setSel(next)
      }
      const apply = () => {
        if (selected.length === 0) { onApply(null, t('freeNothing')); return }
        onApply(buildFreeTierEntries(configured, selected), null)
      }
      const statusBadges = [
        t('freeConfigured').replace('{n}', String(configured.length)),
        t('freeLive').replace('{n}', String(live.length)),
        added.length > 0 ? t('freeAdded').replace('{n}', String(added.length)) : null,
      ].filter(Boolean).join(' · ')
      return React.createElement('div', { style: styles.card },
        React.createElement('div', { style: styles.cardHead },
          React.createElement('div', { style: { minWidth: 0 } },
            React.createElement('h3', { style: styles.cardName }, t('freeTitle')),
            React.createElement('p', { style: styles.cardMeta }, t('freeHint')),
          ),
          React.createElement('div', { style: styles.actions },
            React.createElement('span', { style: { ...styles.badge, color: 'var(--dsw-alias-label-secondary)', borderColor: 'var(--dsw-alias-border-l2)' } }, statusBadges),
            onFetch
              ? React.createElement('button', {
                style: { ...styles.button, ...(fetching || busy !== null ? styles.buttonDisabled : {}) },
                disabled: fetching || busy !== null,
                onClick: onFetch,
              }, fetching ? t('refreshing') : t('freeFetch'))
              : null,
          ),
        ),
        free.error
          ? React.createElement('p', { style: styles.error }, `${t('loadFailed')}: ${free.error}`)
          : null,
        free.exists === false
          ? React.createElement('p', { style: styles.hint }, t('freeMissing'))
          : null,
        free.revision !== null && free.revision !== undefined
          ? React.createElement('p', { style: styles.hint }, `${t('freeRevision')}: ${free.revision}`)
          : null,
        stale.length > 0
          ? React.createElement('p', { style: styles.hint }, `${t('freeDelistedHint')} (${stale.join(', ')})`)
          : null,
        configured.length === 0 && live.length === 0
          ? React.createElement('p', { style: styles.hint }, t('freeEmpty'))
          : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            // Configured rows: still there, checked, removable by unchecking.
            configured.map(entry => React.createElement('div', { key: entry.id, style: styles.row },
              React.createElement(Checkbox, {
                checked: wanted.has(entry.id),
                disabled: busy !== null,
                onChange: () => toggle(entry.id),
                style: { flex: '1 1 auto', fontSize: 13, color: 'var(--dsw-alias-label-primary)', gap: 8 },
                label: React.createElement('span', null,
                  React.createElement('span', { style: { fontWeight: 600 } }, entry.name || entry.id),
                  ' ',
                  React.createElement('span', { style: { opacity: 0.65, fontSize: 12 } }, entry.id),
                  ' ',
                  React.createElement('span', { style: { opacity: 0.7, fontSize: 11 } },
                    `${fmtNumber(entry.contextWindow)} / ${fmtNumber(entry.maxTokens)}`),
                  Array.isArray(entry.input) && entry.input.includes('image')
                    ? React.createElement('span', { style: { marginLeft: 6, opacity: 0.7, fontSize: 11 } }, t('imageCapable'))
                    : null,
                ),
              }),
              stale.includes(entry.id)
                ? React.createElement('span', {
                  style: { ...styles.badge, color: 'var(--dsw-alias-state-warning-primary, #d97706)', borderColor: 'var(--dsw-alias-state-warning-primary, #d97706)' },
                }, t('freeStale'))
                : null,
            )),
            // Online rows that are not configured yet: checking one adopts it.
            live.filter(id => !configuredIds.includes(id)).map(id => React.createElement('div', { key: id, style: styles.row },
              React.createElement(Checkbox, {
                checked: wanted.has(id),
                disabled: busy !== null,
                onChange: () => toggle(id),
                style: { flex: '1 1 auto', fontSize: 13, color: 'var(--dsw-alias-label-secondary)', gap: 8 },
                label: React.createElement('span', null,
                  React.createElement('span', null, id),
                  ' ',
                  React.createElement('span', { style: { opacity: 0.6, fontSize: 11 } }, t('capacityAssumed')),
                ),
              }),
            )),
          ),
        React.createElement('div', { style: styles.actions },
          React.createElement('button', {
            style: { ...styles.button, ...(busy !== null ? styles.buttonDisabled : {}) },
            disabled: busy !== null,
            onClick: () => setSel([...new Set([...configuredIds, ...live])]),
          }, t('freeSelectAll')),
          React.createElement('button', {
            style: { ...styles.button, ...(busy !== null ? styles.buttonDisabled : {}) },
            disabled: busy !== null,
            onClick: () => setSel(configuredIds),
          }, t('freeSelectNone')),
          React.createElement('button', {
            style: { ...styles.button, ...styles.buttonPrimary, ...(busy !== null ? styles.buttonDisabled : {}) },
            disabled: busy !== null,
            onClick: apply,
          }, t('freeApply')),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Session headers
     * ------------------------------------------------------------------ */

    function SessionCard(props) {
      const { t, session, form, setForm, busy, onSave, onClear, notice } = props
      const data = session || {}
      const value = form !== null
        ? form
        : {
            enabled: data.enabled !== false,
            nanoidSessionId: data.nanoidSessionId !== false,
            seedSessionId: data.seedSessionId === true,
            verbose: data.verbose === true,
            nanoidLength: String(data.nanoidLength ?? 8),
            nanoidAlphabet: data.nanoidAlphabet === 'urlsafe' ? 'urlsafe' : 'alphanumeric',
            providers: formatList(data.providers),
            hosts: formatList(data.hosts),
            headers: formatList(data.headers),
            extraHeaders: formatHeaderLines(data.extraHeaders),
            userAgent: typeof data.userAgent === 'string' ? data.userAgent : '',
          }
      const update = (field, raw) => setForm({ ...value, [field]: raw })
      const save = () => {
        const length = Number(value.nanoidLength)
        if (!Number.isInteger(length) || length < 4 || length > 32) { onSave(null, t('sessionLengthInvalid')); return }
        const providers = parseList(value.providers)
        const hosts = parseList(value.hosts)
        const headers = parseList(value.headers)
        // A line without a colon would be silently dropped by the parser; the
        // card refuses instead so the operator sees the typo.
        const extraHeaders = parseHeaderLines(value.extraHeaders)
        const extraLines = String(value.extraHeaders || '')
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line.length > 0 && !line.startsWith('#'))
        if (extraLines.length !== Object.keys(extraHeaders).length) {
          onSave(null, t('sessionExtraInvalid'))
          return
        }
        onSave({
          enabled: value.enabled === true,
          nanoidSessionId: value.nanoidSessionId === true,
          seedSessionId: value.seedSessionId === true,
          verbose: value.verbose === true,
          nanoidLength: length,
          nanoidAlphabet: value.nanoidAlphabet,
          providers: providers.length > 0 ? providers : ['opencode', 'opencode-go'],
          hosts: hosts.length > 0 ? hosts : ['opencode.ai'],
          headers,
          extraHeaders,
          userAgent: value.userAgent.trim(),
        }, null)
      }
      const recent = Array.isArray(data.recent) ? data.recent : []
      const fieldLabel = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', flexBasis: 150, flexGrow: 0, flexShrink: 0 }
      return React.createElement('div', { style: styles.card },
        React.createElement('div', { style: styles.cardHead },
          React.createElement('div', { style: { minWidth: 0 } },
            React.createElement('h3', { style: styles.cardName }, t('sessionTitle')),
            React.createElement('p', { style: styles.cardMeta }, t('sessionHint')),
          ),
          React.createElement('div', { style: styles.actions },
            React.createElement('span', { style: { ...styles.badge, color: 'var(--dsw-alias-label-secondary)', borderColor: 'var(--dsw-alias-border-l2)' } },
              t('sessionInjected').replace('{n}', String(data.injected ?? 0))),
          ),
        ),
        React.createElement(Checkbox, {
          checked: value.enabled,
          disabled: busy !== null,
          label: t('sessionEnabled'),
          style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
          onChange: next => update('enabled', next),
        }),
        value.enabled
          ? React.createElement(React.Fragment, null,
            React.createElement(Checkbox, {
              checked: value.nanoidSessionId,
              disabled: busy !== null,
              label: `${t('sessionNanoid')} — ${t('sessionNanoidHint')}`,
              style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
              onChange: next => update('nanoidSessionId', next),
            }),
            React.createElement('div', { style: styles.fieldRow },
              React.createElement('span', { style: fieldLabel }, t('sessionNanoidLength')),
              React.createElement('input', {
                style: { ...styles.input, ...styles.smallInput },
                value: value.nanoidLength,
                disabled: busy !== null || !value.nanoidSessionId,
                onChange: event => update('nanoidLength', event.target.value),
              }),
              React.createElement('span', { style: fieldLabel }, t('sessionNanoidAlphabet')),
              React.createElement('select', {
                style: { ...styles.input, ...styles.midInput },
                value: value.nanoidAlphabet,
                disabled: busy !== null || !value.nanoidSessionId,
                onChange: event => update('nanoidAlphabet', event.target.value),
              },
                React.createElement('option', { value: 'alphanumeric' }, t('sessionAlphabetAlnum')),
                React.createElement('option', { value: 'urlsafe' }, t('sessionAlphabetUrl')),
              ),
            ),
            React.createElement(Checkbox, {
              checked: value.seedSessionId,
              disabled: busy !== null,
              label: `${t('sessionSeed')} — ${t('sessionSeedHint')}`,
              style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
              onChange: next => update('seedSessionId', next),
            }),
            React.createElement(Checkbox, {
              checked: value.verbose,
              disabled: busy !== null,
              label: `${t('sessionVerbose')} — ${t('sessionVerboseHint')}`,
              style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
              onChange: next => update('verbose', next),
            }),
            React.createElement('div', { style: styles.fieldRow },
              React.createElement('span', { style: fieldLabel }, t('sessionProviders')),
              React.createElement('input', {
                style: styles.input,
                value: value.providers,
                disabled: busy !== null,
                title: t('sessionProvidersHint'),
                onChange: event => update('providers', event.target.value),
              }),
            ),
            React.createElement('div', { style: styles.fieldRow },
              React.createElement('span', { style: fieldLabel }, t('sessionHosts')),
              React.createElement('input', {
                style: styles.input,
                value: value.hosts,
                disabled: busy !== null,
                title: t('sessionHostsHint'),
                onChange: event => update('hosts', event.target.value),
              }),
            ),
            React.createElement('div', { style: styles.fieldRow },
              React.createElement('span', { style: fieldLabel }, t('sessionHeaders')),
              React.createElement('input', {
                style: styles.input,
                value: value.headers,
                disabled: busy !== null,
                title: t('sessionHeadersHint'),
                onChange: event => update('headers', event.target.value),
              }),
            ),
            React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
                `${t('sessionExtraHeaders')} — ${t('sessionExtraHeadersHint')}`),
              React.createElement('textarea', {
                style: styles.textarea,
                value: value.extraHeaders,
                disabled: busy !== null,
                spellCheck: false,
                onChange: event => update('extraHeaders', event.target.value),
              }),
            ),
            React.createElement('div', { style: styles.fieldRow },
              React.createElement('span', { style: fieldLabel }, t('sessionUserAgent')),
              React.createElement('input', {
                style: styles.input,
                value: value.userAgent,
                disabled: busy !== null,
                title: t('sessionUserAgentHint'),
                onChange: event => update('userAgent', event.target.value),
              }),
            ),
          )
          : React.createElement('p', { style: styles.hint }, t('sessionDisabledHint')),
        React.createElement('p', { style: styles.hint }, t('sessionEnvNote')),
        React.createElement('div', { style: styles.actions },
          React.createElement('button', {
            style: { ...styles.button, ...styles.buttonPrimary, ...(busy !== null ? styles.buttonDisabled : {}) },
            disabled: busy !== null,
            onClick: save,
          }, t('save')),
          onClear
            ? React.createElement('button', {
              style: { ...styles.button, ...(busy !== null ? styles.buttonDisabled : {}) },
              disabled: busy !== null,
              onClick: onClear,
            }, t('sessionClear'))
            : null,
        ),
        React.createElement('div', { style: styles.divider }),
        React.createElement('p', { style: styles.sectionTitle }, t('sessionRecent')),
        recent.length === 0
          ? React.createElement('p', { style: styles.hint }, t('sessionNone'))
          : React.createElement('table', { style: styles.table },
            React.createElement('thead', null,
              React.createElement('tr', null,
                React.createElement('th', { style: styles.th }, t('sessionTime')),
                React.createElement('th', { style: styles.th }, t('sessionUrl')),
                React.createElement('th', { style: styles.th }, t('sessionHeadersCol')),
                React.createElement('th', { style: styles.th }, t('sessionIdCol')),
                React.createElement('th', { style: styles.th }, t('sessionTokenCol')),
                React.createElement('th', { style: styles.th }, t('sessionErrorCol')),
              ),
            ),
            React.createElement('tbody', null,
              recent.map((entry, index) => React.createElement('tr', { key: `${entry.at}-${index}` },
                React.createElement('td', { style: styles.td }, entry.at ? new Date(entry.at).toLocaleTimeString() : '—'),
                React.createElement('td', { style: styles.td }, entry.url || '—'),
                React.createElement('td', { style: styles.td }, Array.isArray(entry.headers) ? entry.headers.join(', ') : '—'),
                React.createElement('td', { style: styles.td }, entry.sessionId || '—'),
                React.createElement('td', { style: styles.td }, entry.token || '—'),
                React.createElement('td', { style: styles.td }, entry.error || ''),
              )),
            ),
          ),
        notice
          ? React.createElement('p', { style: { ...styles.notice, ...(notice.ok ? styles.noticeOk : styles.noticeErr) } }, notice.text)
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * Local usage (day × model)
     * ------------------------------------------------------------------ */

    const USAGE_WINDOWS = [1, 7, 30, 90]

    function usageWindowLabel(days, t) {
      if (days === 1) return t('usageDay1')
      if (days === 7) return t('usageDay7')
      if (days === 30) return t('usageDay30')
      return t('usageDay90')
    }

    function UsageShareCell(props) {
      const { share } = props
      const percent = Math.max(0, Math.min(1, typeof share === 'number' && Number.isFinite(share) ? share : 0))
      return React.createElement('td', { style: styles.tdNum },
        React.createElement('div', { style: styles.shareCell },
          React.createElement('div', { style: styles.shareTrack },
            React.createElement('div', { style: { ...styles.shareFill, width: (percent * 100).toFixed(1) + '%' } })),
          React.createElement('span', null, (percent * 100).toFixed(1) + '%'),
        ),
      )
    }

    function ImNotifyRow(props) {
      const { t, report, config, busy, onPick, onTest, testing } = props
      const bots = report && Array.isArray(report.bots) ? report.bots : []
      const withTargets = bots.filter(bot => bot.targets.length > 0)
      const selectedBot = config.botId
      const bot = bots.find(candidate => candidate.botId === selectedBot) ?? withTargets[0] ?? null
      const targetId = config.targetId && bot && bot.targets.some(t2 => t2.targetId === config.targetId)
        ? config.targetId
        : (bot && bot.targets[0] ? bot.targets[0].targetId : '')
      const ready = report && report.available && withTargets.length > 0
      return React.createElement('div', { style: styles.barRow },
        React.createElement('div', { style: styles.fieldRow },
          React.createElement('strong', null, t('imTitle')),
          React.createElement('label', { style: styles.fieldRow },
            React.createElement('input', {
              type: 'checkbox',
              style: styles.check,
              checked: config.enabled === true,
              disabled: busy !== null && busy !== undefined,
              onChange: () => onPick({ enabled: !config.enabled }),
            }),
            t('imEnable'),
          ),
        ),
        React.createElement('p', { style: styles.hint }, t('imHint')),
        report && report.reason
          ? React.createElement('p', { style: styles.hint }, report.reason)
          : null,
        ready
          ? React.createElement('div', { style: styles.row },
              withTargets.length > 1
                ? React.createElement('select', {
                    style: styles.input,
                    value: bot ? bot.botId : '',
                    disabled: busy !== null && busy !== undefined,
                    onChange: event => {
                      const next = withTargets.find(candidate => candidate.botId === event.target.value)
                      onPick({ botId: event.target.value, targetId: next && next.targets[0] ? next.targets[0].targetId : '' })
                    },
                  }, withTargets.map(candidate => React.createElement('option', {
                    key: candidate.botId,
                    value: candidate.botId,
                  }, `${candidate.channel} · ${candidate.botId}`)))
                : React.createElement('span', { style: styles.hint }, `${t('imBot')}: ${bot.channel}`),
              React.createElement('select', {
                style: styles.input,
                value: targetId,
                disabled: busy !== null && busy !== undefined,
                onChange: event => onPick({ botId: bot.botId, targetId: event.target.value }),
              }, (bot ? bot.targets : []).map(target => React.createElement('option', {
                key: target.targetId,
                value: target.targetId,
              }, target.name))),
              React.createElement('button', {
                style: styles.button,
                disabled: testing === true || (busy !== null && busy !== undefined),
                onClick: onTest,
              }, testing === true ? t('imTesting') : t('imTest')),
            )
          : null,
        props.lastResult
          ? React.createElement('p', {
              style: { ...styles.hint, ...(props.lastResult.sent ? styles.noticeOk : styles.noticeErr) },
            }, props.lastResult.sent
              ? t('imSent')
              : t('imFailed').replace('{error}', props.lastResult.error ?? 'unknown'))
          : null,
      )
    }

    function ModelNewsCard(props) {
      const {
        t, watch, busy, onCheck, onAdopt, onDismiss, checking,
        im, imConfig, imResult, onImPick, onImTest, imTesting,
      } = props
      const enabled = watch ? watch.enabled !== false : true
      const tiers = watch && watch.tiers ? watch.tiers : { go: { pending: [], gone: [] }, free: { pending: [], gone: [] } }
      const rows = ['go', 'free'].map(tierId => ({
        tierId,
        label: tierId === 'go' ? t('poolTitle') : t('freeTitle'),
        pending: Array.isArray(tiers[tierId]?.pending) ? tiers[tierId].pending : [],
        gone: Array.isArray(tiers[tierId]?.gone) ? tiers[tierId].gone : [],
      })).filter(row => row.pending.length > 0 || row.gone.length > 0)
      const when = value => (value ? new Date(value).toLocaleString() : '')

      return React.createElement('div', { style: { ...styles.card, ...(rows.length > 0 ? styles.bannerWarn : null) } },
        React.createElement(ImNotifyRow, {
          t, report: im, config: imConfig, busy, onPick: onImPick, onTest: onImTest,
          testing: imTesting, lastResult: imResult,
        }),
        React.createElement('div', { style: styles.divider }),
        React.createElement('div', { style: styles.cardHead },
          React.createElement('h3', { style: styles.cardName }, t('newsTitle')),
          React.createElement('div', { style: styles.row },
            React.createElement('button', {
              style: styles.button,
              disabled: checking === true || !enabled,
              onClick: onCheck,
            }, checking === true ? t('refreshing') : t('newsCheck')),
            watch && watch.lastCheckedAt
              ? React.createElement('span', { style: styles.dayLabel },
                  t('newsChecked').replace('{when}', when(watch.lastCheckedAt)))
              : null,
          ),
        ),
        React.createElement('p', { style: styles.cardMeta },
          enabled
            ? t('newsHint').replace('{minutes}', String(Math.round((watch?.intervalMs ?? 0) / 60000)))
            : t('newsOff')),
        watch && watch.error
          ? React.createElement('p', { style: styles.error }, t('newsFailed').replace('{error}', watch.error))
          : null,
        rows.length === 0
          ? React.createElement('p', { style: styles.hint }, t('newsNone'))
          : rows.map(row => React.createElement('div', { key: row.tierId, style: styles.barRow },
              React.createElement('div', { style: styles.barHead },
                React.createElement('span', { style: { fontWeight: 600 } }, `${row.label} · ${t('newsNew')} ${row.pending.length}`),
                React.createElement('span', null, `${t('newsGone')} ${row.gone.length}`),
              ),
              row.pending.map(item => React.createElement('div', { key: `${row.tierId}-${item.id}`, style: styles.fieldRow },
                React.createElement('code', null, item.id),
                React.createElement('span', { style: styles.dayLabel },
                  t('newsSince').replace('{when}', when(item.firstSeenAt))),
              )),
              row.gone.map(item => React.createElement('div', { key: `${row.tierId}-gone-${item.id}`, style: styles.fieldRow },
                React.createElement('code', { style: { textDecoration: 'line-through', opacity: 0.7 } }, item.id),
              )),
              React.createElement('div', { style: styles.actions },
                React.createElement('button', {
                  style: styles.button,
                  disabled: busy !== null && busy !== undefined,
                  onClick: () => onAdopt(row.tierId, row.pending.map(item => item.id)),
                }, row.tierId === 'go' ? t('newsFetchGo') : t('newsAdoptFree')),
                React.createElement('button', {
                  style: styles.button,
                  disabled: busy !== null && busy !== undefined,
                  onClick: () => onDismiss(row.tierId),
                }, t('newsDismiss')),
              ),
            )),
      )
    }

    /* ------------------------------------------------------------------ *
     * Composer dock
     * ------------------------------------------------------------------ */

    /**
     * One bare observable for the dock's facts, owned by the apply closure and
     * shared by every render occurrence: the same snapshot reference until a
     * fact moves, and one poller no matter how many conversations are open.
     * @returns the observable the renderer binds as `useDockState`.
     */
    function createDockState() {
      let value = { news: null, usage: null, error: null, suppressed: 0 }
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        patch(next) {
          value = { ...value, ...next }
          for (const listener of [...listeners]) listener()
        },
      }
    }

    function DockPills(props) {
      const { t, useDockState, dismissNews } = props
      const state = useDockState(value => value)
      const news = state.news
      const usage = state.usage
      // The nudge is local: dismissing it here must not clear the host's
      // pending list, which is the work list the settings card acts on.
      const unseen = news !== null && news.pendingTotal > state.suppressed
      return React.createElement('div', { style: styles.dockRoot },
        unseen
          ? React.createElement('button', {
              type: 'button',
              style: { ...styles.dockPill, ...styles.dockButton },
              title: t('dockNewsHint'),
              onClick: dismissNews,
            },
              React.createElement('span', { style: styles.dockDot, 'aria-hidden': 'true' }),
              t('dockNews').replace('{n}', String(news.pendingTotal - state.suppressed)),
            )
          : null,
        usage !== null && usage.tokens > 0
          ? React.createElement('span', {
              style: styles.dockPill,
              title: t('dockUsageHint').replace('{calls}', String(usage.calls)),
            },
              `${t('dockUsage').replace('{tokens}', fmtNumber(usage.tokens))} · ${usage.source === 'log' ? t('dockSourceLog') : t('dockSourceLive')}`,
            )
          : state.error
            ? React.createElement('span', { style: styles.dockPill, title: state.error }, t('dockFailed'))
            : null,
      )
    }

    function UsageBreakdownCard(props) {
      const { t, data, error, loading, windowDays, setWindowDays, onRefresh, onToggle, onSource, busy } = props
      const enabled = data ? data.enabled !== false : true
      const source = data && data.source === 'log' ? 'log' : 'live'
      const totals = data && data.totals ? data.totals : null
      const models = data && Array.isArray(data.models) ? data.models : []
      const days = data && Array.isArray(data.days) ? data.days : []
      const sweep = data && data.sweep ? data.sweep : null
      const peak = days.reduce((max, day) => (day.total > max ? day.total : max), 0)
      const cacheShare = totals && totals.total > 0 ? (totals.cacheRead / totals.total) * 100 : 0

      return React.createElement('div', { style: styles.card },
        React.createElement('div', { style: styles.cardHead },
          React.createElement('h3', { style: styles.cardName }, t('usageTitle')),
          React.createElement('div', { style: styles.row },
            React.createElement('label', { style: styles.fieldRow },
              React.createElement('input', {
                type: 'checkbox',
                style: styles.check,
                checked: enabled,
                disabled: busy !== null && busy !== undefined,
                onChange: () => onToggle(!enabled),
              }),
              t('usageEnable'),
            ),
            // The two sources are exclusive, so this writes the same field the
            // service reads; a switch restarts the count from the new source.
            React.createElement('button', {
              style: { ...styles.button, ...(source === 'live' ? styles.buttonPrimary : {}) },
              disabled: !enabled || loading,
              onClick: () => onSource('live'),
            }, t('usageSourcePickLive')),
            React.createElement('button', {
              style: { ...styles.button, ...(source === 'log' ? styles.buttonPrimary : {}) },
              disabled: !enabled || loading,
              onClick: () => onSource('log'),
            }, t('usageSourcePickLog')),
          ),
        ),
        React.createElement('p', { style: styles.cardMeta }, t('usageHint')),

        enabled
          ? React.createElement(React.Fragment, null,
              React.createElement('div', { style: styles.actions },
                React.createElement('span', { style: styles.hint }, t('usageWindow')),
                USAGE_WINDOWS.map(days => React.createElement('button', {
                  key: days,
                  style: { ...styles.button, ...(windowDays === days ? styles.buttonPrimary : {}) },
                  onClick: () => setWindowDays(days),
                }, usageWindowLabel(days, t))),
                React.createElement('button', {
                  style: styles.button,
                  disabled: loading,
                  onClick: onRefresh,
                }, loading ? t('refreshing') : t('refresh')),
              ),

              error
                ? React.createElement('p', { style: styles.error }, t('usageFailed').replace('{error}', error))
                : null,

              totals
                ? React.createElement('p', { style: styles.hint },
                    `${t('usageCalls')} ${fmtNumber(totals.calls)}`
                    + ` · ${t('usageTotal')} ${fmtNumber(totals.total)}`
                    + ` · ${t('usageInput')} ${fmtNumber(totals.input)}`
                    + ` · ${t('usageCache')} ${fmtNumber(totals.cacheRead)}`
                    + ` · ${t('usageOutput')} ${fmtNumber(totals.output)}`)
                : null,

              totals && totals.total > 0
                ? React.createElement('p', { style: styles.hint },
                    t('usageCacheShare').replace('{pct}', cacheShare.toFixed(1) + '%'))
                : null,

              days.length > 0
                ? React.createElement(React.Fragment, null,
                    React.createElement('div', { style: styles.dayStrip }, days.map(day => {
                      const height = peak > 0 && day.total > 0
                        ? Math.max(4, Math.round((day.total / peak) * 44))
                        : 2
                      return React.createElement('div', {
                        key: day.date,
                        style: styles.dayCell,
                        title: `${day.date} · ${fmtNumber(day.total)}`,
                      },
                        React.createElement('div', {
                          style: { ...(day.total > 0 ? styles.dayBar : styles.dayBarEmpty), height: height + 'px' },
                        }),
                        React.createElement('span', { style: styles.dayLabel }, day.date.slice(5)),
                      )
                    })),
                  )
                : null,

              models.length > 0
                ? React.createElement('table', { style: styles.table },
                    React.createElement('thead', null,
                      React.createElement('tr', null,
                        React.createElement('th', { style: styles.th }, t('usageModelCol')),
                        React.createElement('th', { style: { ...styles.th, textAlign: 'right' } }, t('usageCalls')),
                        React.createElement('th', { style: { ...styles.th, textAlign: 'right' } }, t('usageInput')),
                        React.createElement('th', { style: { ...styles.th, textAlign: 'right' } }, t('usageCache')),
                        React.createElement('th', { style: { ...styles.th, textAlign: 'right' } }, t('usageOutput')),
                        React.createElement('th', { style: { ...styles.th, textAlign: 'right' } }, t('usageTotal')),
                        React.createElement('th', { style: { ...styles.th, textAlign: 'right' } }, t('usageShare')),
                      )),
                    React.createElement('tbody', null,
                      models.map(row => React.createElement('tr', { key: row.model },
                        React.createElement('td', { style: styles.td }, row.model),
                        React.createElement('td', { style: styles.tdNum }, fmtNumber(row.calls)),
                        React.createElement('td', { style: styles.tdNum }, fmtNumber(row.input)),
                        React.createElement('td', { style: styles.tdNum }, fmtNumber(row.cacheRead)),
                        React.createElement('td', { style: styles.tdNum }, fmtNumber(row.output)),
                        React.createElement('td', { style: styles.tdNum }, fmtNumber(row.total)),
                        React.createElement(UsageShareCell, { share: row.share }),
                      )),
                      React.createElement('tr', null,
                        React.createElement('td', { style: { ...styles.td, fontWeight: 600 } }, t('usageTotal')),
                        React.createElement('td', { style: { ...styles.tdNum, fontWeight: 600 } }, fmtNumber(totals.calls)),
                        React.createElement('td', { style: { ...styles.tdNum, fontWeight: 600 } }, fmtNumber(totals.input)),
                        React.createElement('td', { style: { ...styles.tdNum, fontWeight: 600 } }, fmtNumber(totals.cacheRead)),
                        React.createElement('td', { style: { ...styles.tdNum, fontWeight: 600 } }, fmtNumber(totals.output)),
                        React.createElement('td', { style: { ...styles.tdNum, fontWeight: 600 } }, fmtNumber(totals.total)),
                        React.createElement('td', { style: styles.tdNum }, '100%'),
                      ),
                    ),
                  )
                : React.createElement('div', { style: styles.banner },
                    React.createElement('p', { style: { margin: 0, fontWeight: 600 } }, t('usageEmpty')),
                    React.createElement('p', { style: styles.hint },
                      source === 'log' ? t('usageSourceLogEmpty') : t('usageSourceLiveEmpty')),
                  ),

              source === 'live'
                ? React.createElement('p', { style: styles.hint },
                    `${t('usageSource')}: ${t('usageSourceLive')}`)
                : null,

              source === 'log' && sweep
                ? React.createElement('p', { style: styles.hint },
                    t('usageSweep')
                      .replace('{sessions}', String(sweep.sessions))
                      .replace('{processed}', String(sweep.processed))
                      .replace('{failed}', String(sweep.failed))
                    + (sweep.complete
                      ? ''
                      : ' ' + t('usageSweepPending').replace('{pending}', String(Math.max(0, sweep.changed - sweep.processed))))
                    + (data.updatedAt ? ` · ${t('usageUpdated')} ${new Date(data.updatedAt).toLocaleTimeString()}` : ''))
                : null,
            )
          : React.createElement('p', { style: styles.hint }, t('usageDisabled')),
      )
    }

    /* ------------------------------------------------------------------ *
     * Page
     * ------------------------------------------------------------------ */

    function PoolPage(props) {
      const { t, api } = props
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [failures, setFailures] = React.useState(0)
      const [pollMs, setPollMs] = React.useState(30000)
      const [tick, setTick] = React.useState(Date.now())
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [strategy, setStrategy] = React.useState(null)
      const [modelSel, setModelSel] = React.useState(null)
      const [freeSel, setFreeSel] = React.useState(null)
      const [sessionForm, setSessionForm] = React.useState(null)
      const [sessionNotice, setSessionNotice] = React.useState(null)
      const [usage, setUsage] = React.useState(null)
      const [usageError, setUsageError] = React.useState(null)
      const [usageLoading, setUsageLoading] = React.useState(false)
      const [usageWindow, setUsageWindow] = React.useState(7)
      const [checkingModels, setCheckingModels] = React.useState(false)
      const [im, setIm] = React.useState(null)
      const [imResult, setImResult] = React.useState(null)
      const [imTesting, setImTesting] = React.useState(false)
      const [refreshing, setRefreshing] = React.useState(false)
      const [fetching, setFetching] = React.useState(false)
      const [freeFetching, setFreeFetching] = React.useState(false)
      const [loadedAt, setLoadedAt] = React.useState(null)

      const load = React.useCallback(async () => {
        setRefreshing(true)
        try {
          const remote = await api()
          if (!remote) throw new Error('opencodeSuite remote is unavailable')
          const result = unwrapRemote(await remote.status())
          setData(result)
          setError(null)
          setFailures(0)
          setLoadedAt(new Date())
          if (result && typeof result.usageRefreshMs === 'number' && result.usageRefreshMs > 0) {
            setPollMs(result.usageRefreshMs)
          }
        } catch (err) {
          setFailures(prev => prev + 1)
          setError(String((err && err.message) || err))
        } finally {
          setRefreshing(false)
        }
      }, [api])

      React.useEffect(() => { load() }, [load])
      React.useEffect(() => {
        if (failures >= 3) return undefined
        const timer = setInterval(() => { load() }, pollMs)
        return () => clearInterval(timer)
      }, [load, pollMs, failures])
      React.useEffect(() => {
        const timer = setInterval(() => setTick(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [])

      const runAction = React.useCallback(async (fn, confirmText) => {
        if (confirmText && typeof window !== 'undefined' && typeof window.confirm === 'function'
            && !window.confirm(confirmText)) return
        setBusy(confirmText || 'busy')
        setNotice(null)
        try {
          const remote = await api()
          if (!remote) throw new Error('opencodeSuite remote is unavailable')
          await unwrapRemote(await fn(remote))
          await load()
        } catch (err) {
          setNotice({ ok: false, text: `${t('actionFailed')}: ${String((err && err.message) || err)}` })
        } finally {
          setBusy(null)
        }
      }, [api, load, t])

      const onKeyAction = (kind, id, confirmText, extra) => {
        runAction(async remote => {
          if (kind === 'setActive') return remote.setActive(id)
          if (kind === 'setDisabled') return remote.setDisabled(id, extra !== false)
          if (kind === 'clearExhausted') return remote.clearExhausted(id)
          return remote.clearInvalid(id)
        }, confirmText)
      }

      const onSaveKeys = (rows, invalidMessage) => {
        if (!rows) {
          setNotice({ ok: false, text: `${t('saveFailed')}: ${invalidMessage}` })
          return
        }
        runAction(async remote => {
          // Persist the key list first; an empty reference name auto-generates
          // from the key id, so pasting just a label + secret always works.
          const keys = rows.map(row => ({
            id: row.id,
            label: row.label,
            apiKeyEnv: row.apiKeyEnv || 'OPENCODE_GO_KEY_' + row.id.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase(),
          }))
          let result = await remote.putKeys(keys)
          if (result && result.ok === false) return result
          for (const row of rows) {
            if (!row.secret) continue
            result = await remote.putKeySecret(row.id, row.secret)
            if (result && result.ok === false) return result
          }
          setDraft(null)
          return result
        }, null).then(() => setNotice(prev => (prev && !prev.ok ? prev : { ok: true, text: t('saved') })))
      }

      const onSetStrategy = (patch) => {
        runAction(async remote => remote.putConfig(patch), null).then(() => {
          setStrategy(null)
          setNotice(prev => (prev && !prev.ok ? prev : { ok: true, text: t('saved') }))
        })
      }

      const onSetModels = (patch) => {
        runAction(async remote => remote.putConfig(patch), null).then(() => {
          setModelSel(null)
          setNotice(prev => (prev && !prev.ok ? prev : { ok: true, text: t('saved') }))
        })
      }

      const onFetchModels = async () => {
        setFetching(true)
        setNotice(null)
        try {
          const remote = await api()
          if (!remote) throw new Error('opencodeSuite remote is unavailable')
          const result = unwrapRemote(await remote.refreshModels())
          await load()
          setModelSel(null)
          setNotice({
            ok: true,
            text: t('modelFetched')
              .replace('{count}', String(result && result.count))
              .replace('{added}', String(Array.isArray(result && result.added) ? result.added.length : 0)),
          })
        } catch (err) {
          setNotice({ ok: false, text: `${t('modelFetchFailed')}: ${String((err && err.message) || err)}` })
        } finally {
          setFetching(false)
        }
      }

      const onApplyFreeTier = (entries, invalidMessage) => {
        if (!entries) {
          setNotice({ ok: false, text: `${t('freeWriteFailed')}: ${invalidMessage}` })
          return
        }
        runAction(async remote => remote.putFreeTierModels(entries, true), null).then(async () => {
          setFreeSel(null)
          setNotice(prev => (prev && !prev.ok ? prev : {
            ok: true,
            text: t('freeWritten').replace('{n}', String(entries.length)),
          }))
        })
      }

      const onFetchFreeTier = async () => {
        setFreeFetching(true)
        setNotice(null)
        try {
          const remote = await api()
          if (!remote) throw new Error('opencodeSuite remote is unavailable')
          const result = unwrapRemote(await remote.freeTier())
          setData(prev => (prev ? { ...prev, freeTier: result } : prev))
          setFreeSel(null)
        } catch (err) {
          setNotice({ ok: false, text: `${t('loadFailed')}: ${String((err && err.message) || err)}` })
        } finally {
          setFreeFetching(false)
        }
      }

      // Local usage is its own request: it folds session logs, so it must not
      // ride the 30s quota poll that reloads the whole page.
      const loadUsage = React.useCallback(async () => {
        setUsageLoading(true)
        try {
          const remote = await api()
          if (!remote) throw new Error('opencodeSuite remote is unavailable')
          // Positional: the binder maps call arguments onto the declared wire
          // fields in order, so an object here would arrive as the VALUE of
          // `days` and fail the host's boundary validation.
          const result = unwrapRemote(await remote.usageBreakdown(usageWindow))
          setUsage(result)
          setUsageError(null)
        } catch (err) {
          setUsageError(String((err && err.message) || err))
        } finally {
          setUsageLoading(false)
        }
      }, [api, usageWindow])

      const onToggleUsage = (on) => {
        runAction(async remote => remote.putConfig({ usageLogEnabled: on }), null).then(loadUsage)
      }

      const loadImTargets = React.useCallback(async () => {
        try {
          const remote = await api()
          if (!remote) return
          setIm(unwrapRemote(await remote.imTargets()))
        } catch (err) {
          setIm({ available: false, reason: String((err && err.message) || err), bots: [] })
        }
      }, [api])

      React.useEffect(() => { loadImTargets() }, [loadImTargets])

      const onImPick = (patch) => {
        runAction(async remote => remote.putConfig({
          notifyImEnabled: patch.enabled ?? (data && data.imNotify ? data.imNotify.enabled === true : false),
          ...(patch.botId === undefined ? {} : { notifyImBotId: patch.botId }),
          ...(patch.targetId === undefined ? {} : { notifyImTargetId: patch.targetId }),
        }), null).then(load)
      }

      const onImTest = () => {
        setImTesting(true)
        ;(async () => {
          try {
            const remote = await api()
            if (!remote) throw new Error('opencodeSuite remote is unavailable')
            // Positional, and never omitted: the client binder counts call
            // arguments against the descriptor and refuses a short call, which
            // the host's acceptsUndefined does not relax. An empty body means
            // "send what the watcher would send", which the service decides.
            setImResult(unwrapRemote(await remote.testImNotify('')))
          } catch (err) {
            setImResult({ sent: false, error: String((err && err.message) || err) })
          } finally {
            setImTesting(false)
          }
        })()
      }

      const onCheckModels = async () => {
        setCheckingModels(true)
        try {
          const remote = await api()
          if (!remote) throw new Error('opencodeSuite remote is unavailable')
          await unwrapRemote(await remote.checkModels())
          await load()
        } catch (err) {
          setNotice({ ok: false, text: `${t('actionFailed')}: ${String((err && err.message) || err)}` })
        } finally {
          setCheckingModels(false)
        }
      }

      const onAdoptNews = (tierId, ids) => {
        if (tierId === 'go') {
          onFetchModels()
          return
        }
        // The free tier writes its whole list, so the new ids go in as bare
        // entries alongside whatever is configured now.
        const configured = data && data.freeTier && Array.isArray(data.freeTier.configured)
          ? data.freeTier.configured.map(entry => entry.id)
          : []
        const entries = buildFreeTierEntries(configured, [...new Set([...configured, ...ids])])
        if (entries === null || entries === undefined) {
          setNotice({ ok: false, text: `${t('saveFailed')}: ${t('actionFailed')}` })
          return
        }
        runAction(async remote => remote.putFreeTierModels(entries, true), null).then(async () => {
          await remoteDismissNews(tierId)
          await load()
        })
      }

      const remoteDismissNews = async (tierId) => {
        const remote = await api()
        if (!remote) throw new Error('opencodeSuite remote is unavailable')
        await unwrapRemote(await remote.dismissModelNews(tierId))
      }

      const onDismissNews = (tierId) => {
        runAction(() => remoteDismissNews(tierId), null).then(load)
      }

      const onUsageSource = (source) => {
        runAction(async remote => remote.putConfig({ usageLogSource: source }), null).then(loadUsage)
      }

      React.useEffect(() => { loadUsage() }, [loadUsage])

      // A store with many sessions folds over several sweeps. Keep asking while
      // one is still queued — each request is bounded, so this converges in the
      // background instead of blocking the page.
      React.useEffect(() => {
        if (!usage || !usage.sweep || usage.sweep.complete) return undefined
        const timer = setTimeout(() => { loadUsage() }, 1500)
        return () => clearTimeout(timer)
      }, [usage, loadUsage])

      const onSaveSession = (patch, invalidMessage) => {
        if (!patch) {
          setSessionNotice({ ok: false, text: `${t('saveFailed')}: ${invalidMessage}` })
          return
        }
        setBusy('session')
        setSessionNotice(null)
        ;(async () => {
          try {
            const remote = await api()
            if (!remote) throw new Error('opencodeSuite remote is unavailable')
            await unwrapRemote(await remote.putSessionHeaders(patch))
            await load()
            setSessionForm(null)
            setSessionNotice({ ok: true, text: t('saved') })
          } catch (err) {
            setSessionNotice({ ok: false, text: `${t('saveFailed')}: ${String((err && err.message) || err)}` })
          } finally {
            setBusy(null)
          }
        })()
      }

      const onClearSessionLog = async () => {
        setBusy('session-log')
        setSessionNotice(null)
        try {
          const remote = await api()
          if (!remote) throw new Error('opencodeSuite remote is unavailable')
          await unwrapRemote(await remote.clearSessionLog())
          await load()
          setSessionForm(null)
          setSessionNotice({ ok: true, text: t('sessionCleared') })
        } catch (err) {
          setSessionNotice({ ok: false, text: `${t('actionFailed')}: ${String((err && err.message) || err)}` })
        } finally {
          setBusy(null)
        }
      }

      const takeover = data ? data.takeover : null
      const keys = Array.isArray(data && data.keys) ? data.keys : []

      return React.createElement('div', { style: styles.wrap },
        React.createElement('div', { style: styles.head },
          React.createElement('div', { style: { color: 'var(--dsw-alias-state-business-primary)' } },
            React.createElement(SuiteMark, { size: 24 }),
          ),
          React.createElement('div', null,
            React.createElement('h2', { style: styles.title }, t('title')),
            React.createElement('p', { style: styles.subtitle }, t('subtitle')),
          ),
        ),
        data === null && !error
          ? React.createElement('p', { style: styles.hint }, t('loading'))
          : null,
        error
          ? React.createElement('div', { style: styles.banner },
            React.createElement('p', { style: styles.error }, `${t('loadFailed')}: ${error}`),
            failures >= 3 ? React.createElement('p', { style: styles.hint }, t('paused')) : null,
            React.createElement('button', { style: styles.button, onClick: () => { setFailures(0); load() } }, t('refresh')),
          )
          : null,
        data === null
          ? null
          : React.createElement(React.Fragment, null,
            React.createElement('div', { style: { ...styles.banner, ...(takeover === 'waiting' ? styles.bannerWarn : styles.bannerOk) } },
              React.createElement('p', { style: { margin: 0, fontWeight: 600 } },
                takeover === 'serving' ? t('takeoverServing')
                  : takeover === 'own-route' ? t('takeoverOwnRoute') : t('takeoverWaiting')),
              takeover === 'waiting'
                ? React.createElement('p', { style: styles.hint },
                    data.takeoverHint ? `${t('takeoverWaitingHint')} ${data.takeoverHint}` : t('takeoverWaitingHint'))
                : null,
              React.createElement('p', { style: styles.hint },
                `${t('poolTitle')}: ${t('usableCount').replace('{n}', String(data.usableCount ?? 0))}`
                + ` · ${t('preemptNote')}: ${data.preemptAtPercent >= 100 ? t('preemptOff') : data.preemptAtPercent + '%'}`
                + ` · ${t('consecNote')}: ${data.switchAfterConsecutiveFailures > 0 ? data.switchAfterConsecutiveFailures : t('preemptOff')}`),
              data.lastSwitch
                ? React.createElement('p', { style: styles.hint },
                    `${t('lastSwitch')}: ${data.lastSwitch.from ?? '—'} → ${data.lastSwitch.to ?? '—'} (${switchReasonText(data.lastSwitch.reason, t)}) @ ${new Date(data.lastSwitch.at).toLocaleString()}`)
                : null,
            ),

            // ── Go tier ──────────────────────────────────────────────
            React.createElement('p', { style: styles.sectionTitle }, t('poolTitle')),
            React.createElement('p', { style: styles.hint }, t('poolHint')),
            React.createElement(ModelCard, {
              t, data, sel: modelSel, setSel: setModelSel, busy,
              onFetchModels, fetching,
              onSave: (patch, invalidMessage) => {
                if (!patch) {
                  setNotice({ ok: false, text: `${t('saveFailed')}: ${invalidMessage}` })
                  return
                }
                onSetModels(patch)
              },
            }),
            keys.length > 0
              ? React.createElement(StrategyCard, {
                t, data, strategy, setStrategy, busy,
                onSave: (patch, invalidMessage) => {
                  if (!patch) {
                    setNotice({ ok: false, text: `${t('saveFailed')}: ${invalidMessage}` })
                    return
                  }
                  onSetStrategy(patch)
                },
              })
              : null,
            keys.length === 0 && takeover !== 'waiting'
              ? React.createElement('div', { style: styles.banner },
                React.createElement('p', { style: { margin: 0, fontWeight: 600 } }, t('noKeysTitle')),
                React.createElement('p', { style: styles.hint }, t('noKeysHint')),
              )
              : null,
            keys.map(item => React.createElement(KeyCard, {
              key: item.id, item, t, tick, busy, onAction: onKeyAction,
            })),
            draft === null
              ? React.createElement('button', {
                style: styles.button,
                disabled: busy !== null,
                onClick: () => setDraft(keys.map(key => ({ id: key.id, label: key.label, apiKeyEnv: key.apiKeyEnv, secret: '' }))),
              }, t('manageTitle'))
              : React.createElement(Editor, { draft, setDraft, t, busy, onSave: onSaveKeys, existingKeys: keys }),
            notice
              ? React.createElement('p', { style: { ...styles.notice, ...(notice.ok ? styles.noticeOk : styles.noticeErr) } }, notice.text)
              : null,
            React.createElement('div', { style: styles.actions },
              React.createElement('button', { style: styles.button, disabled: busy !== null || refreshing, onClick: load },
                refreshing ? t('refreshing') : t('refresh')),
              loadedAt
                ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
                    `${t('updatedAt')} ${loadedAt.toLocaleTimeString()}`)
                : null,
            ),

            React.createElement('div', { style: styles.divider }),
            React.createElement(ModelNewsCard, {
              t, watch: data.modelWatch, busy, checking: checkingModels,
              onCheck: onCheckModels, onAdopt: onAdoptNews, onDismiss: onDismissNews,
              im, imConfig: data.imNotify ?? { enabled: false, botId: '', targetId: '' },
              imResult, onImPick, onImTest, imTesting,
            }),

            React.createElement('div', { style: styles.divider }),
            React.createElement(UsageBreakdownCard, {
              t, data: usage, error: usageError, loading: usageLoading,
              windowDays: usageWindow, setWindowDays: setUsageWindow,
              onRefresh: loadUsage, onToggle: onToggleUsage, onSource: onUsageSource, busy,
            }),

            React.createElement('div', { style: styles.divider }),
            React.createElement(FreeTierCard, {
              t, data: data.freeTier, sel: freeSel, setSel: setFreeSel, busy,
              onApply: onApplyFreeTier, onFetch: onFetchFreeTier, fetching: freeFetching,
            }),

            React.createElement('div', { style: styles.divider }),
            React.createElement(SessionCard, {
              t, session: data.sessionHeaders, form: sessionForm, setForm: setSessionForm, busy,
              onSave: onSaveSession, onClear: onClearSessionLog, notice: sessionNotice,
            }),
          ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Registration
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      const mountReady = ctx.remote.$mount(TYPERT_REMOTE)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-opencode-suite: dictionaries')
      const t = ctx.locale.bind(NS)
      injectNavStyle()

      const api = async () => {
        await mountReady
        const remote = ctx.get('remote.opencodeSuite')
        return remote || null
      }
      const injected = () => ({ t, api })

      // ---- composer dock -------------------------------------------------
      // One source, one poller, however many conversations are open. The dock
      // asks for two facts the page already has: how many model ids are still
      // unhandled, and what today cost. Nothing here re-reads storage.
      const dockState = createDockState()
      const refreshDock = async () => {
        try {
          const remote = await api()
          if (!remote) return
          const status = unwrapRemote(await remote.status())
          const usage = unwrapRemote(await remote.usageBreakdown(1))
          const today = usage && usage.days && usage.days.length > 0 ? usage.days[usage.days.length - 1] : null
          dockState.patch({
            news: status && status.modelWatch
              ? { pendingTotal: status.modelWatch.pendingTotal, tiers: status.modelWatch.tiers }
              : null,
            usage: usage && usage.enabled
              ? { tokens: today === null ? 0 : today.total, calls: today === null ? 0 : today.calls, source: usage.source }
              : null,
            error: null,
          })
        } catch (err) {
          dockState.patch({ error: String((err && err.message) || err) })
        }
      }
      // A local suppression, deliberately not the host's dismiss: that one
      // clears the work list the settings card acts on.
      const dismissDockNews = () => {
        const current = dockState.getSnapshot()
        if (current.news === null) return
        dockState.patch({ suppressed: current.news.pendingTotal })
      }
      ctx.effect(() => {
        void refreshDock()
        const timer = setInterval(() => { void refreshDock() }, 60000)
        // A browser timer has no unref; a Node one must not hold a test process
        // open, and nothing here is worth keeping the loop alive for.
        timer.unref?.()
        return () => clearInterval(timer)
      }, 'opencode-suite: composer dock state')
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'model-news',
        // After the stats pills (order 0) so the reading order stays
        // performance → news.
        order: 10,
        locale: NS,
        inject: () => ({ hooks: { dockState }, dismissNews: dismissDockNews }),
      }, DockPills))

      // Error boundary: any render crash inside the page becomes a VISIBLE
      // diagnostic instead of a blank content column, so problems self-report.
      class SuitePageBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }
        static getDerivedStateFromError(error) {
          return { error }
        }
        render() {
          if (this.state.error !== null) {
            const err = this.state.error
            return React.createElement('div', {
              style: {
                padding: 16,
                border: '1px solid var(--dsw-alias-state-error-primary)',
                borderRadius: 10,
                color: 'var(--dsw-alias-state-error-primary)',
                fontSize: 13,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              },
            },
              React.createElement('p', { style: { margin: 0, fontWeight: 600 } }, 'OpenCode 套件 · 渲染异常'),
              React.createElement('p', { style: { margin: '8px 0 0' } }, String((err && err.message) || err)),
              React.createElement('p', { style: { margin: '8px 0 0', opacity: 0.75 } }, String((err && err.stack) || '').slice(0, 1200)),
            )
          }
          return React.createElement(PoolPage, this.props)
        }
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'opencode-suite',
        order: 42,
        label: () => {
          try {
            return navLabel(t)
          } catch {
            // Degrade to plain text if the shell ever rejects element labels.
            return t('nav')
          }
        },
        locale: NS,
        inject: injected,
      }, SuitePageBoundary))
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    // Render-path test hooks (unused by the runtime; see test/client.test.mjs).
    exports.__test = {
      SuiteMark,
      UsageBar,
      Checkbox,
      badgeFor,
      fmtReset,
      fmtNumber,
      barColor,
      usageErrorText,
      switchReasonText,
      parseList,
      formatList,
      parseHeaderLines,
      formatHeaderLines,
      imageModelsPatch,
      capacityEditable,
      capacityDraft,
      buildCapacityPatch,
      buildFreeTierEntries,
      KeyCard,
      Editor,
      StrategyCard,
      ModelCard,
      FreeTierCard,
      SessionCard,
      ModelNewsCard,
      ImNotifyRow,
      DockPills,
      createDockState,
      UsageBreakdownCard,
      PoolPage,
      TYPERT_REMOTE,
      unwrapRemote,
      zh,
      en,
    }
    return module.exports
  },
})
