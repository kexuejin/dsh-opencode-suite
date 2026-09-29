/**
 * Host half of dsh-opencode-suite — one DeepSeek Harness plugin that does
 * everything OpenCode needs:
 *
 *   1. A multi-key pool with silent in-stream quota failover plus a usage
 *      dashboard, behind one OpenCode Zen route.
 *   2. opencode-style session headers on the wire.
 *   3. Both tiers' model catalogs, managed by agent tools and a settings page.
 *
 * One class-based Cordis plugin that also exposes the `opencodeSuite` Typert
 * Remote (strict-mode dispatch driven by `typert.host.js`):
 *
 *   1. Exposes every live field through the `opencode-suite` settings form and
 *      writes keys and policy through the settings service, which validates the
 *      complete Config and fences stale revisions.
 *   2. Maintains the KeyPool state machine, persisted to
 *      `$DSH_HOME/opencode-suite.state.json`.
 *   3. Owns the provider route (default `opencode-go`, taking over the
 *      single-key route dsh-llm-pi-ai serves): an LlmAdapter whose stream()
 *      silently retries with the next pool key on quota/credential failures
 *      that arrive before any content, so the conversation never notices.
 *      While the route is owned elsewhere the plugin stays dormant and
 *      re-attempts registration on every `llm/adapters-updated` commit.
 *   4. Scopes every `llm/stream` to its conversation session id and wraps
 *      `globalThis.fetch` so requests to opencode endpoints carry the session
 *      headers opencode itself sends. Headers only — nothing else changes.
 *   5. Answers the card: per-key quota, pool actions, the pooled catalog
 *      policy, the free tier's llm-pi-ai model list, and live session-header
 *      diagnostics.
 *
 * @module dsh-opencode-suite
 */

import z from '@deepseek-ai/schemastery'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef, isCredentialKeySegment, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  assertUsableApiKey,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import { KeyPool, assertKeyList, authFaultKind } from './pool.js'
import { UsageCache, fetchUsage } from './usage.js'
import {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_SESSIONS_PER_SWEEP,
  DEFAULT_SWEEP_MAX_MS,
  DEFAULT_WINDOW_DAYS,
  UsageLedger,
} from './usage-log.js'
import {
  ASSUMED_CONTEXT_WINDOW,
  ASSUMED_MAX_TOKENS,
  SETTINGS_NS,
  TIERS,
  TIER_IDS,
  assertIdList,
  capacitiesFor,
  diffEntries,
  dynamicModelDescriptor,
  fetchModelListings,
  filterFreeTierLive,
  loadModelsCache,
  mergeEntries,
  normalizeEntry,
  parseListing,
  removeEntries,
  saveModelsCache,
  withDeclaredInput,
} from './catalog.js'
import { FreeTierError, describeRevision, readRouteApiKeyEnv, readRouteModels, writeRouteModels } from './free-tier.js'
import { ModelWatcher, WATCHED_TIERS } from './model-watch.js'
import {
  DEFAULT_HEADERS,
  InjectionLog,
  createEnvFallback,
  createSessionScope,
  installSessionHeaderFetch,
  normalizeSessionConfig,
  observedIterable,
  scopedIterable,
  wireSessionIdOf,
} from './session.js'
import { createTools } from './tools.js'

export const name = 'opencode-suite'

const NS = 'opencode-suite'
const DISPLAY_NAME = 'OpenCode Zen Go（池）'
const DEFAULT_ROUTE = 'opencode-go'
const ALT_ROUTE = 'opencode-suite-go'
const DEFAULT_USAGE_BASE_URL = 'https://opencode.ai/zen/go/v1/usage'
const DEFAULT_MODELS_BASE_URL = 'https://opencode.ai/zen/go/v1/models'
const DEFAULT_FREE_MODELS_BASE_URL = 'https://opencode.ai/zen/v1/models'
const STATE_FILE = 'opencode-suite.state.json'
const MODELS_CACHE_FILE = 'opencode-suite.models.json'
const USAGE_STATE_FILE = 'opencode-suite.usage.json'
// The live source lives in memory between turns, so it is flushed on a timer
// and on dispose: a host restart must not erase the day's totals. Writing is
// throttled because a busy turn folds several calls a second.
const USAGE_FLUSH_MS = 5000
const MODEL_WATCH_FILE = 'opencode-suite.watched.json'
const DEFAULT_MODEL_WATCH_MS = 900000
const DEFAULT_USAGE_REFRESH_MS = 30000
const DEFAULT_TIMEOUT_MS = 15000
const USAGE_CACHE_TTL_MS = 15000
const LISTING_CACHE_TTL_MS = 60000
const REVIVE_THRESHOLD_PERCENT = 98
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000
const INJECTION_LOG_LIMIT = 20
// llm-pi-ai reads these three off the resolved profile while it streams, so a
// profile object assembled outside its config loader has to carry the same
// defaults that loader applies (config.ts).
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/** The default bounded transient-retry code set, plus quota for pool rotation. */
const BASE_RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']

/** One pooled key: an id, a display label, and the credential that holds its secret. */
const keyEntry = z.object({
  id: z.string(),
  label: z.string(),
  apiKeyEnv: z.string().role('credential-ref'),
})

const capacityEntry = z.object({
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

const sessionHeadersSchema = z.object({
  enabled: z.boolean().default(true),
  providers: z.array(z.string()).default([...['opencode', 'opencode-go']]),
  hosts: z.array(z.string()).default(['opencode.ai']),
  baseURLs: z.array(z.string()).default([]),
  headers: z.array(z.string()).default([...DEFAULT_HEADERS]),
  extraHeaders: z.dict(z.string()).default({}),
  userAgent: z.string().default(''),
  sessionIdEnv: z.string().default(''),
  verbose: z.boolean().default(false),
  disableFetchInjection: z.boolean().default(false),
  seedSessionId: z.boolean().default(false),
  nanoidSessionId: z.boolean().default(true),
  nanoidLength: z.number().step(1).min(4).max(32).default(8),
  nanoidAlphabet: z.union(['alphanumeric', 'urlsafe']).default('alphanumeric'),
}).default({})

/** Every field is live: a settings form write reaches the running pool, route,
 * and session-header injector without remounting this entry. */
export const Config = z.object({
  route: z.union([DEFAULT_ROUTE, ALT_ROUTE]).default(DEFAULT_ROUTE).volatile(),
  // A key list is only well-formed as a whole (unique ids and reference names),
  // which no per-field schema states; the callback refuses a write that
  // duplicates or malforms an entry before it persists.
  keys: z.transform(z.array(keyEntry), value => {
    assertKeyList(value)
    return value
  }).default([]).volatile(),
  preemptAtPercent: z.number().min(0).max(100).default(100).volatile(),
  // Consecutive non-quota failures (rate limit / server / timeout) after which
  // the pool rotates away from a key; 0 disables the rule.
  switchAfterConsecutiveFailures: z.number().min(0).max(20).default(0).volatile(),
  // Which models the pooled route exposes. 'all' follows the catalog (new
  // models appear automatically); 'custom' exposes exactly `models`.
  modelMode: z.union(['all', 'custom']).default('all').volatile(),
  models: z.array(z.string()).default([]).volatile(),
  // Model ids the pooled route declares to accept image input. The Go catalog
  // declares no capability for its DeepSeek rows — the models endpoint
  // publishes none at all — so a gateway model that accepts images reads as
  // text-only until it is listed here, and `read_image` plus pasted images are
  // refused for it. A descriptor the catalog already declares image-capable
  // needs no entry. An id the route does not serve is inert, which keeps a
  // fetched-then-removed model harmless.
  imageModels: z.array(z.string()).default([]).volatile(),
  // Real capacities for synthesized (fetched) models, keyed by model id. The
  // listing endpoint discloses ids only, so an adopted model otherwise rides
  // the documented defaults; a card or tool that learns better numbers writes
  // them here.
  modelCapacities: z.dict(capacityEntry).default({}).volatile(),
  usageBaseUrl: z.string().default(DEFAULT_USAGE_BASE_URL).volatile(),
  modelsBaseUrl: z.string().default(DEFAULT_MODELS_BASE_URL).volatile(),
  freeModelsBaseUrl: z.string().default(DEFAULT_FREE_MODELS_BASE_URL).volatile(),
  usageRefreshMs: z.number().min(5000).max(300000).default(DEFAULT_USAGE_REFRESH_MS).volatile(),
  timeoutMs: z.number().min(1000).max(120000).default(DEFAULT_TIMEOUT_MS).volatile(),
  // Local token accounting (see usage-log.js). The usage endpoint reports plan
  // windows per key and never a model breakdown, so this is where "which model
  // burns the window" comes from.
  usageLogEnabled: z.boolean().default(true).volatile(),
  // Where the numbers come from. 'live' counts what this host streams while the
  // plugin is on: instant, no reads, no history from before it was enabled.
  // 'log' folds the durable session log instead: full history, but the first
  // pass over a large store takes minutes and is spread over refreshes. One
  // call seen by both would be counted twice, so the sources are exclusive.
  usageLogSource: z.union(['live', 'log']).default('live').volatile(),
  // Days the card and the tool report. Storage keeps the retention horizon
  // regardless, so widening the window costs no re-scan.
  usageLogWindowDays: z.number().min(1).max(365).default(DEFAULT_WINDOW_DAYS).volatile(),
  usageLogRetentionDays: z.number().min(1).max(3650).default(DEFAULT_RETENTION_DAYS).volatile(),
  // How many changed sessions one refresh may open, and how long it may spend
  // on them. Both bound the same thing: a card load or a tool call must answer
  // quickly on a store with thousands of sessions. Whatever is left stays
  // queued and `sweep.complete` says so.
  usageLogSessionsPerSweep: z.number().min(1).max(5000).default(DEFAULT_SESSIONS_PER_SWEEP).volatile(),
  usageLogSweepMaxMs: z.number().min(200).max(120000).default(DEFAULT_SWEEP_MAX_MS).volatile(),
  // Watch both tiers' online listings and report what is new or gone, so a
  // model that ships overnight does not wait for a card poll to be noticed.
  modelWatchEnabled: z.boolean().default(true).volatile(),
  modelWatchIntervalMs: z.number().min(300000).max(86400000).default(DEFAULT_MODEL_WATCH_MS).volatile(),
  // Push new-model news over the IM plugin's proactive delivery. The bot and
  // its target are DISCOVERED through dsh-im (listBots / listTargets) and picked
  // in the card, never hand-copied into a file; dsh-im owns creating them,
  // because a bot needs platform credentials this plugin has no business
  // holding.
  notifyImEnabled: z.boolean().default(false).volatile(),
  notifyImBotId: z.string().default('').volatile(),
  notifyImTargetId: z.string().default('').volatile(),
  sessionHeaders: sessionHeadersSchema.volatile(),
})

/** Unwrap this entry's Config references into plain values for one operation.
 * @param config Parsed plugin Config whose fields the schema declared volatile.
 * @returns The live section snapshot.
 */
function plainSection(config) {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [
    key,
    typeof value === 'object' && value !== null && typeof value.get === 'function' ? value.get() : value,
  ]))
}

/* ------------------------------------------------------------------ *
 * Profile assembly
 * ------------------------------------------------------------------ */

/**
 * Build the resolved pi-ai profile for the opencode-go catalog route.
 *
 * The catalog provider is wrapped so that models fetched from the official
 * models endpoint (see refreshModels) are merged into listModels /
 * resolveModel / stream: pi-ai reads `provider.getModels()` on every call, so
 * appending freshly pulled descriptors makes new supplier models usable
 * without a pi-ai package release. Known (shipped) models are never touched.
 *
 * The same wrapper applies the deployment's declared image capability to both
 * lists, so `inputModalities` follows the configuration rather than a supplier
 * catalog snapshot that publishes no capability metadata.
 * @param route - provider route id.
 * @param dynamicDescriptors - live supplier-model descriptors for the route.
 * @param declaredImages - live `imageModels` list.
 */
function buildProfile(route, dynamicDescriptors, declaredImages) {
  const upstream = opencodeGoProvider()
  if (upstream.id !== route) upstream.id = route
  const provider = {
    ...upstream,
    getModels: () => {
      const base = upstream.getModels()
      const extras = dynamicDescriptors(route).filter(descriptor => !base.some(m => m.id === descriptor.id))
      const imageModels = declaredImages()
      return (extras.length > 0 ? [...base, ...extras] : base).map(model => withDeclaredInput(model, imageModels))
    },
  }
  return {
    provider: route,
    displayName: DISPLAY_NAME,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: resolveRetryPolicy(undefined, 'opencode-suite.catalog.retryPolicy'),
    piProvider: provider,
    configuredMaxTokens: new Map(),
    // Per-model diagnostics this route declares none of: the adapter reads
    // this map on every resolve, so it has to exist.
    modelErrors: new Map(),
  }
}

/**
 * The `auth` option every PiAiAdapter this plugin builds needs.
 *
 * Pool keys never travel through it — each attempt passes its own key as the
 * request-level override — so the store stays a read-only window on the harness
 * credential records: a write would create a second place a key can live, and
 * it fails loud instead. Ambient lookups answer from the credential seam first,
 * then the process environment, which is where a deployment exports them.
 * @param ctx - the plugin context carrying the optional `ctx.credentials`.
 * @returns the pi-ai auth injection for `createModels()`.
 */
function poolAuth(ctx) {
  const seam = () => ctx.get('credentials')
  return {
    credentials: {
      async read(providerId) {
        const credentials = seam()
        if (credentials === undefined || !isCredentialKeySegment(providerId)) return undefined
        const record = await credentials.readRecord(recordKeyFor(providerId))
        if (record === undefined) return undefined
        if (record.kind !== 'api-key') return record.payload
        return {
          type: 'api_key',
          ...record.key === undefined ? {} : { key: record.key },
          ...record.env === undefined ? {} : { env: { ...record.env } },
        }
      },
      async list() {
        return []
      },
      async modify(providerId) {
        throw new LlmError(
          `opencode-suite: provider-native sign-in for "${providerId}" is unavailable on the pooled route;`
          + ' add the key to the pool instead (Settings → OpenCode 套件 → Key 管理), where the pool stores it as a'
          + ' credential reference',
          'UNSTORABLE_PROVIDER_ID',
        )
      },
      async delete(providerId) {
        throw new LlmError(
          `opencode-suite: the pool stores no provider-native credential for "${providerId}"`,
          'UNSTORABLE_PROVIDER_ID',
        )
      },
    },
    authContext: {
      async env(envName) {
        if (isCredentialRefName(envName)) {
          const hit = await seam()?.resolve(credentialRef(envName))
          if (hit !== undefined) return hit.value
        }
        return process.env[envName]
      },
      async fileExists(path) {
        const target = path.startsWith('~') ? join(homedir(), path.slice(1)) : path
        try {
          return statSync(target).isFile()
        } catch {
          return false
        }
      },
    },
  }
}

/** A terminal error finish stating the whole pool is dry. */
function dryPoolFinish(message) {
  return {
    type: 'finish',
    reason: { kind: 'error', failure: { code: QUOTA_EXCEEDED_CODE, message } },
  }
}

/** Does this chunk mean the stream has started producing user-visible output? */
function isContentChunk(chunk) {
  return chunk.type === 'block-start'
    || chunk.type === 'text-delta'
    || chunk.type === 'reasoning-delta'
    || chunk.type === 'tool-call-delta'
    || chunk.type === 'block-end'
}

function failureOf(error) {
  if (error && typeof error === 'object'
      && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: error.code, message: error.message }
  }
  return null
}

/**
 * Re-word a model/region rejection before it reaches the user.
 *
 * The provider answers these on 401/403, so the harness labels them `AUTH` and
 * they arrive looking exactly like a dead key. The pool deliberately leaves the
 * keys alone for them (see `authFaultKind`), so the raw "check your key"
 * framing would send the reader to the wrong place. Every other finish passes
 * through untouched, including the provider's own words.
 *
 * @param {{type: string, reason: object}} chunk - a terminal finish chunk.
 * @param {string} [model] - the model the attempt asked for.
 * @returns {object} the finish chunk, re-worded when it is a model/region fault.
 */
function explainFinish(chunk, model) {
  const failure = chunk.reason.kind === 'error' ? chunk.reason.failure : null
  if (!failure || authFaultKind(failure) !== 'model') return chunk
  const detail = String(failure.message ?? '').trim()
  const message = `opencode-suite: the provider rejected model "${String(model ?? 'unknown')}" for this account or region`
    + `${detail.length > 0 ? ` — ${detail}` : ''}. This is not a credential fault, so the key pool was left untouched; `
    + 'choose another model in Settings → OpenCode 套件 → 模型选择.'
  return { ...chunk, reason: { ...chunk.reason, failure: { ...failure, message } } }
}

/**
 * The pool adapter. Metadata (catalog, retry policy shape, model resolution)
 * delegates to a catalog PiAiAdapter; stream() runs the failover loop.
 */
class OpenCodeSuiteAdapter extends LlmAdapter {
  constructor(plugin) {
    super()
    this.plugin = plugin
  }

  providerInfo(provider) {
    return { id: provider, name: DISPLAY_NAME }
  }

  providerRetryPolicy(_provider) {
    const budget = Math.max(2, this.plugin.pool.keyCount())
    return resolveRetryPolicy({
      mode: 'normal',
      maxRetries: budget,
      retryableCodes: [...BASE_RETRYABLE_CODES, QUOTA_EXCEEDED_CODE],
    }, 'opencode-suite.retryPolicy')
  }

  async listModels(provider) {
    const list = await this.plugin.innerCatalog.listModels(provider)
    const selection = this.plugin.modelSelection()
    if (selection === null) return list
    return list.filter(entry => selection.has(entry.id))
  }

  async resolveModel(provider, model, signal) {
    const selection = this.plugin.modelSelection()
    if (selection !== null && !selection.has(model)) {
      throw new LlmError(
        `model "${model}" is not enabled in the OpenCode suite catalog (Settings → OpenCode 套件 → 模型选择)`,
        'UNKNOWN_MODEL',
      )
    }
    return this.plugin.innerCatalog.resolveModel(provider, model, signal)
  }

  async *stream(options) {
    const selection = this.plugin.modelSelection()
    if (selection !== null && options.model && !selection.has(options.model)) {
      throw new LlmError(
        `model "${options.model}" is not enabled in the OpenCode suite catalog (Settings → OpenCode 套件 → 模型选择)`,
        'UNKNOWN_MODEL',
      )
    }
    const pool = this.plugin.pool
    const attempts = pool.usableCount() + 1
    for (let attempt = 0; attempt < attempts; attempt++) {
      const entry = pool.currentKey()
      if (!entry) {
        yield dryPoolFinish('opencode-suite: every key is exhausted, disabled, or invalid — add or revive a key in Settings → OpenCode 套件')
        return
      }
      const inner = this.plugin.makeAttemptAdapter(entry)
      let emitted = false
      let silentRetry = false
      let finish = null
      try {
        for await (const chunk of inner.stream(options)) {
          if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'error') {
              // A quota code exhausts the key; an AUTH code marks it invalid
              // only on positive evidence of a credential fault; a model or
              // region rejection rotates nothing (every key would answer the
              // same way) and is re-worded instead so the reader is not sent
              // after a healthy key; other codes count the transient-failure
              // streak and rotate once the configured consecutive-failure
              // threshold trips. Any rotation can trigger a silent retry while
              // no content was emitted.
              const failure = chunk.reason.failure
              const rotation = pool.onFailure(entry.id, failure)
              if (rotation !== null) silentRetry = !emitted
              finish = explainFinish(chunk, options.model)
            } else {
              if (chunk.reason.kind !== 'aborted') pool.onSuccess(entry.id)
              finish = chunk
            }
            break
          }
          if (isContentChunk(chunk)) emitted = true
          yield chunk
        }
      } catch (error) {
        const failure = failureOf(error)
        if (failure) {
          const rotation = pool.onFailure(entry.id, failure)
          if (rotation !== null && !emitted) {
            silentRetry = true
          } else {
            throw error
          }
        } else {
          throw error
        }
      }
      if (silentRetry) continue
      if (finish !== null) {
        yield finish
        return
      }
      // Degenerate inner adapter that ended without a terminal finish.
      return
    }
  }
}

/**
 * The plugin service. Extends TypertRemoteService so the Gateway can claim and
 * dispatch the `opencodeSuite` invocations declared in typert.host.js.
 */
/**
 * Describe a refused delivery with the cause chain dsh-im keeps in-process.
 *
 * dsh-im narrows anything it does not recognise to a single public
 * `delivery-failed`, and its own HTTP endpoint returns the same empty code — so
 * the channel's actual stage (a missing token, an offline bridge, a rejected
 * send) only exists on the thrown error's `cause` chain, which is available
 * here and nowhere else. Rendering it turns "delivery-failed: delivery-failed"
 * into the sentence that tells a person what to go fix.
 * @param {unknown} error - the thrown value.
 * @returns {string} the chain, outermost first, repeats dropped.
 */
function describeDeliveryFailure(error) {
  const parts = []
  const seen = new Set()
  let current = error
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const code = typeof current.code === 'string' && current.code.length > 0 ? current.code : null
    const message = typeof current.message === 'string' && current.message.length > 0
      ? current.message
      : (typeof current === 'string' ? current : null)
    const label = code !== null && message !== null && code !== message ? `${code}: ${message}` : (code ?? message)
    if (label !== null && !seen.has(label)) {
      seen.add(label)
      parts.push(label)
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.length > 0 ? parts.join(' ← ') : 'delivery failed without a reason'
}

export class OpenCodeSuite extends TypertRemoteService {
  static inject = ['llm', 'credentials', 'tools']
  static Config = Config

  constructor(ctx, config) {
    super(ctx, 'opencodeSuite')
    this.ctx = ctx
    this.logger = ctx.logger ?? console
    this.config = config ?? {}
    this.current = () => plainSection(this.config)
    // The card owns this entry's page, so the schema-derived page stays off;
    // an optional child keeps the plugin bootable without the settings service.
    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
    this.auth = poolAuth(ctx)

    this.pool = new KeyPool({
      stateFile: dshHomePath(STATE_FILE),
      reviveThresholdPercent: REVIVE_THRESHOLD_PERCENT,
    })
    this.usageCache = new UsageCache({ ttlMs: USAGE_CACHE_TTL_MS })
    // Local token accounting from the session log. The ledger holds no state the
    // host owns, so it is built whether or not the persistence seam exists and
    // simply reports why it is empty when it does not.
    this.usageLedger = new UsageLedger()
    // The live source is in-memory by nature, so it is seeded from its own
    // state file. The log source is never seeded: those numbers are in the
    // session logs, and restoring them here would count them twice.
    this.usageStatePath = dshHomePath(USAGE_STATE_FILE)
    // New-model news: the listing is polled on a timer, and what it finds is
    // remembered so the card can say "new since" instead of repeating itself.
    this.modelWatcher = new ModelWatcher({ statePath: dshHomePath(MODEL_WATCH_FILE) })
    this.modelWatchTimer = null
    this.modelWatchRestarts = 0
    this.usageFlushTimer = null
    if (this.current().usageLogSource !== 'log') this.restoreUsageState()
    // The listing cache uses the same TTL-with-in-flight-dedupe shape: the card
    // polls both tiers while open and the tools ask again on every call.
    this.listingCache = new UsageCache({ ttlMs: LISTING_CACHE_TTL_MS })
    // Models pulled from the official models endpoint, per route.
    // Loaded from a cache file so a fetched lineup survives restarts.
    this.dynamicModels = loadModelsCache(dshHomePath(MODELS_CACHE_FILE))
    // Injectable fetch for refreshModels; undefined = the host fetch.
    this.fetchModelsImpl = undefined

    this.profileRoute = null
    this.profileMap = null
    this.innerCatalog = null
    this.poolAdapter = null
    this.registration = null
    this.servingRoute = null
    this.lastTakeoverError = null
    this.lastModelSelection = null

    // ---- session headers -------------------------------------------------
    this.sessionScope = createSessionScope()
    this.injectionLog = new InjectionLog(INJECTION_LOG_LIMIT)
    // Reads the env-variable name live, so editing it in the card takes effect
    // without a restart.
    this.envFallback = createEnvFallback(() => this.sessionConfig().sessionIdEnv)
    this.wireToken = raw => wireSessionIdOf(raw, this.sessionConfig())

    this.applyConfig()
    ctx.on('loader/volatile-update', () => { this.applyConfig() })

    // ---- session-header wiring (installed once; reads live config) --------
    ctx.on('llm/stream', (options, next) => this.scopeStream(options, next))
    const restoreFetch = installSessionHeaderFetch({
      getConfig: () => this.sessionConfig(),
      getSession: () => {
        const raw = this.sessionScope.current() ?? this.envFallback()
        if (raw === undefined || raw === null || String(raw).length === 0) return undefined
        return { sessionId: String(raw), token: this.wireToken(String(raw)) }
      },
      log: message => this.sessionLog(message),
      injections: this.injectionLog,
    })
    ctx.effect(() => restoreFetch, 'opencode-suite: restore global fetch')

    // ---- agent tools -----------------------------------------------------
    // register() binds each tool to this plugin's fiber and returns its
    // disposer, so stop/uninstall removes all of them without bookkeeping here.
    for (const tool of createTools({ suite: () => this })) ctx.tools.register(tool)

    ctx.effect(() => () => this.flushUsageState(), 'opencode-suite: flush local usage state')
    ctx.effect(() => this.startModelWatch(), 'opencode-suite: model watch')

    this.offAdaptersUpdated = ctx.on('llm/adapters-updated', () => {
      if (this.servingRoute === null) this.tryRegister()
    })
    this.tryRegister()
  }

  // ---- session-header plumbing --------------------------------------------

  /** The live normalized session configuration (safe before settings exist). */
  sessionConfig() {
    try {
      return normalizeSessionConfig(this.current().sessionHeaders)
    } catch {
      return normalizeSessionConfig(undefined)
    }
  }

  /** Verbose-only diagnostic; stderr keeps stdout free for headless/ACP. */
  sessionLog(message) {
    if (!this.sessionConfig().verbose) return
    this.logger?.debug?.(`opencode-suite: ${message}`)
    try {
      console.error(`[opencode-suite] ${message}`)
    } catch {
      // A closed stderr must never break a request.
    }
  }

  /**
   * Scope one `llm/stream` call to its conversation session id so the fetch
   * wrapper reads the right id even with concurrent conversations. Chunks and
   * call options pass through unchanged unless `seedSessionId` is on, whose
   * only wire effect is session request headers.
   */
  scopeStream(options, next) {
    const iterable = this.scopeStreamSession(options, next)
    const usageCfg = this.current()
    if (usageCfg.usageLogEnabled === false || usageCfg.usageLogSource !== 'live') return iterable
    // Account on the same interception that scopes headers: the two compose,
    // and the observer reads only `{type:'usage'}` chunks.
    const provider = options.provider
    const model = options.model
    const ledger = this.usageLedger
    return observedIterable(iterable, (usage) => {
      if (ledger.record({ provider, model, usage })) this.scheduleUsageFlush()
    })
  }

  /** The watcher's wire report, read against the live config. */
  async modelWatchReport() {
    const cfg = this.current()
    const report = this.modelWatcher.report({
      enabled: cfg.modelWatchEnabled !== false,
      intervalMs: cfg.modelWatchIntervalMs,
    })
    // "Online but not exposed" is a different fact from "new since last check",
    // and on a tier this profile never adopted it is the useful one: those ids
    // are not being announced because the first pass took them as its baseline,
    // and nothing else would ever surface them.
    const exposed = new Set((await this.listAvailableModels(cfg)).filter(entry => entry.enabled).map(entry => entry.id))
    // The free tier's configured list lives in the settings document, not in
    // this plugin's catalog. Assuming every online id is unadopted would keep
    // the count stuck at the whole lineup after half of it had been adopted.
    let freeConfigured = new Set()
    try {
      const settings = this.ctx.get('settings')
      if (settings) {
        freeConfigured = new Set(readRouteModels(settings, TIERS.free.route).models.map(entry => entry.id))
      }
    } catch (error) {
      this.logger?.debug?.(`opencode-suite: free-tier configured list unavailable: ${messageOf(error)}`)
    }
    for (const tierId of WATCHED_TIERS) {
      const onlineIds = report.tiers[tierId]?.onlineIds ?? []
      const configured = tierId === 'go' ? exposed : freeConfigured
      report.tiers[tierId].unconfigured = onlineIds.filter(id => !configured.has(id))
    }
    report.unconfiguredTotal = WATCHED_TIERS
      .reduce((total, tierId) => total + report.tiers[tierId].unconfigured.length, 0)
    return report
  }

  /**
   * Start (or restart) the listing watch on the configured interval.
   * @returns a disposer that stops it.
   */
  startModelWatch() {
    this.stopModelWatch()
    const cfg = this.current()
    if (cfg.modelWatchEnabled === false) return () => {}
    const timer = setInterval(() => { void this.checkModels() }, cfg.modelWatchIntervalMs)
    timer.unref?.()
    this.modelWatchTimer = timer
    return () => this.stopModelWatch()
  }

  /**
   * Whether a check is due, judged on the last pass rather than on a timer that
   * only ticks while the process lives.
   * @returns {boolean} true when the configured interval has elapsed.
   */
  modelWatchDue() {
    const cfg = this.current()
    if (cfg.modelWatchEnabled === false) return false
    const last = this.modelWatcher.lastCheckedAt
    if (typeof last !== 'string') return true
    const at = Date.parse(last)
    if (!Number.isFinite(at)) return true
    return Date.now() - at >= cfg.modelWatchIntervalMs
  }

  stopModelWatch() {
    if (this.modelWatchTimer !== null) {
      clearInterval(this.modelWatchTimer)
      this.modelWatchTimer = null
    }
  }

  /**
   * One watch pass over both tiers.
   *
   * A pass that finds something says so once, in the host log, so a headless
   * run learns about it too — the card is only one of the readers.
   * @param {object} [options]
   * @param {boolean} [options.fresh] - bypass the listing cache for this pass.
   * @returns {Promise<{notices: string[]}>} the ids that were new this pass.
   */
  async checkModels({ fresh = false } = {}) {
    const { notices } = await this.modelWatcher.check(async (tierId) => {
      const listing = await this.tierListing(tierId, undefined, { fresh })
      return listing.map(entry => entry.id)
    })
    if (notices.length > 0) {
      this.logger?.info?.(`opencode-suite: new online models: ${notices.join(', ')}`)
      // Deliberately not awaited into the sweep: a slow or refused IM must not
      // hold the listing check, and a failed push leaves the pending list, so
      // the next new id tries again and the card shows what happened.
      void this.pushModelNews(notices)
    }
    return { notices, pendingTotal: this.modelWatcher.pendingCount() }
  }

  /**
   * The IM delivery targets this host can push to, discovered from dsh-im.
   *
   * A bot cannot be created here: it needs platform credentials (a Telegram
   * token, a Feishu app, a WeChat login) that belong to dsh-im's own settings.
   * What this plugin owns is the choice of where an already-configured target
   * receives the news, so the card picks from this list instead of asking anyone
   * to paste an id into a file.
   * @returns `{available, reason, bots}` for the card's picker.
   */
  async imTargets() {
    const im = this.ctx.get('dshIm')
    if (im === undefined || im === null) {
      return { available: false, reason: 'dsh-im is not enabled in this profile', bots: [] }
    }
    let bots
    try {
      bots = await im.listBots()
    } catch (error) {
      return { available: false, reason: messageOf(error), bots: [] }
    }
    const rows = []
    for (const bot of Array.isArray(bots) ? bots : []) {
      if (!bot || typeof bot.botId !== 'string') continue
      let targets = []
      try {
        targets = await im.listTargets(bot.botId)
      } catch (error) {
        // One unreachable channel must not hide the channels that do answer.
        this.logger?.debug?.(`opencode-suite: listTargets failed for ${bot.botId}: ${messageOf(error)}`)
      }
      rows.push({
        botId: bot.botId,
        channel: typeof bot.channel === 'string' ? bot.channel : 'unknown',
        targets: (Array.isArray(targets) ? targets : [])
          .filter(target => target && typeof target.targetId === 'string')
          .map(target => ({
            targetId: target.targetId,
            name: typeof target.name === 'string' && target.name.length > 0 ? target.name : target.targetId,
            kind: typeof target.kind === 'string' ? target.kind : 'unknown',
          })),
      })
    }
    const anyTarget = rows.some(row => row.targets.length > 0)
    return {
      available: true,
      reason: anyTarget
        ? null
        : rows.length === 0
          ? 'dsh-im has no bot in this profile — add one in Settings → IM 机器人'
          : 'no delivery target is configured for any bot — add one on the bot card in Settings → IM 机器人',
      bots: rows,
    }
  }

  /**
   * The text one push carries, built once so the test button and a real notice
   * cannot drift apart.
   * @param ids - the new model ids, newest notice last.
   * @param heading - the first line.
   * @returns the markdown body.
   */
  newsBody(ids, heading) {
    const lines = [`**${heading}**`, '']
    for (const id of ids) lines.push(`- \`${id}\``)
    const gone = WATCHED_TIERS.flatMap(tierId => this.modelWatcher.gone(tierId))
    if (gone.length > 0) lines.push('', `另有 ${gone.length} 个模型已从线上列表消失。`)
    lines.push('', '在「设置 → OpenCode 套件」里上架或拉取。')
    return lines.join('\n')
  }

  /**
   * Send the news over the configured IM target, if one is chosen.
   * @param ids - the new model ids.
   * @returns `{sent, error}`; never throws, because a notification failure is
   *   reported, not propagated into the listing check.
   */
  async pushModelNews(ids) {
    const cfg = this.current()
    if (cfg.notifyImEnabled !== true) return { sent: false, error: null }
    if (ids.length === 0) return { sent: false, error: null }
    return await this.deliver(cfg.notifyImBotId, cfg.notifyImTargetId, this.newsBody(ids, 'OpenCode 上新模型'))
  }

  /**
   * One delivery attempt against dsh-im, with every known refusal named.
   * @param botId - the configured bot.
   * @param targetId - the configured delivery target.
   * @param text - the message body.
   * @returns `{sent, error}`.
   */
  async deliver(botId, targetId, text) {
    const fail = reason => ({ sent: false, error: reason })
    if (typeof botId !== 'string' || botId.length === 0) return fail('no IM bot is chosen')
    if (typeof targetId !== 'string' || targetId.length === 0) return fail('no IM target is chosen')
    const im = this.ctx.get('dshIm')
    if (im === undefined || im === null) return fail('dsh-im is not enabled in this profile')
    try {
      const result = await im.send(botId, targetId, text, { format: 'markdown' })
      if (result?.sent === true) return { sent: true, error: null }
      return fail(`the IM plugin did not confirm the send: ${JSON.stringify(result ?? null)}`)
    } catch (error) {
      return { sent: false, error: describeDeliveryFailure(error) }
    }
  }

  /**
   * The card's test button: send the news the watcher would send right now.
   * @param {string} [text] - override the body.
   * @returns `{sent, error}`.
   */
  async testImNotify(text) {
    const cfg = this.current()
    const ids = WATCHED_TIERS.flatMap(tierId => this.modelWatcher.pending(tierId).map(row => row.id))
    const body = typeof text === 'string' && text.trim().length > 0
      ? text
      : this.newsBody(ids.length > 0 ? ids : ['grok-4.7'], 'OpenCode 上新模型（测试）')
    return await this.deliver(cfg.notifyImBotId, cfg.notifyImTargetId, body)
  }

  /**
   * Dismiss one tier's news. The seen set is kept, so the dismissed ids are
   * not announced again until they leave and come back.
   * @param tierId - `go` or `free`.
   * @returns {number} how many pending ids were dropped.
   */
  dismissModelNews(tierId) {
    return this.modelWatcher.acknowledge(tierId)
  }

  /** Read the persisted live counters back in, if any survive. */
  restoreUsageState() {
    try {
      this.usageLedger.restore(JSON.parse(readFileSync(this.usageStatePath, 'utf8')))
    } catch {
      // Missing or corrupt state file: the card starts from what this run sees.
    }
  }

  /** Fold the live counters into the state file soon, not on every call. */
  scheduleUsageFlush() {
    if (this.usageFlushTimer !== null) return
    this.usageFlushTimer = setTimeout(() => {
      this.usageFlushTimer = null
      this.flushUsageState()
    }, USAGE_FLUSH_MS)
    this.usageFlushTimer.unref?.()
  }

  /**
   * Write the live counters now (best-effort atomic write).
   *
   * Losing the file costs a re-count from the next restart; it never costs the
   * pool, the route, or a turn, so a write failure is swallowed rather than
   * surfaced.
   */
  flushUsageState() {
    if (this.usageFlushTimer !== null) {
      clearTimeout(this.usageFlushTimer)
      this.usageFlushTimer = null
    }
    try {
      mkdirSync(dirname(this.usageStatePath), { recursive: true })
      const tmp = `${this.usageStatePath}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.usageLedger.serialize(), null, 2))
      renameSync(tmp, this.usageStatePath)
    } catch {
      // Best effort: the counters stay in memory and flush on the next call.
    }
  }

  /**
   * Bind one `llm/stream` call to its conversation session id.
   * @param options - the stream request.
   * @param next - the downstream continuation.
   * @returns the downstream result, unchanged.
   */
  scopeStreamSession(options, next) {
    const cfg = this.sessionConfig()
    if (!cfg.enabled) return next()
    let sessionId = options.sessionId
    if ((typeof sessionId !== 'string' || sessionId.length === 0) && cfg.seedSessionId) {
      if (typeof options.provider === 'string' && cfg.providers.includes(options.provider)) {
        sessionId = this.envFallback()
        if (!Object.isFrozen(options)) {
          try {
            options.sessionId = sessionId
          } catch {
            // Frozen request object; the fetch injection still applies.
          }
        }
      }
    }
    if (sessionId === undefined || sessionId === null || String(sessionId).length === 0) return next()
    const sid = String(sessionId)
    this.sessionLog(`scoping llm/stream ${options.provider}/${options.model} to session ${sid}`
      + ` → wire ${this.wireToken(sid)}`)
    return scopedIterable(this.sessionScope, sid, next())
  }

  // ---- configuration & registration ---------------------------------------

  /**
   * Persist volatile Config fields through the settings service, which validates
   * the complete Config and commits them into this instance's live references.
   * @param {object} patch - Fields to merge; unlisted fields keep their values.
   */
  async writeSection(patch) {
    const settings = this.ctx.get('settings')
    if (!settings) throw new FreeTierError('the settings service is unavailable', 'NO_SETTINGS')
    await settings.update(NS, patch)
  }

  applyConfig() {
    const cfg = this.current()
    this.pool.setPreempt(cfg.preemptAtPercent)
    this.pool.setConsecutiveThreshold(cfg.switchAfterConsecutiveFailures)
    this.pool.syncKeys(cfg.keys)

    if (this.profileRoute !== cfg.route) {
      this.profileRoute = cfg.route
      this.profileMap = new Map([[cfg.route, buildProfile(
        cfg.route,
        route => this.dynamicModelDescriptors(route),
        () => this.current().imageModels ?? [],
      )]])
      this.innerCatalog = new PiAiAdapter({
        profiles: () => this.profileMap,
        auth: this.auth,
        resolveApiKey: async () => {
          throw new Error('opencode-suite: the catalog adapter never resolves keys')
        },
        resolveAttachments: () => this.ctx.get('attachments'),
      })
    }
    if (!this.poolAdapter) this.poolAdapter = new OpenCodeSuiteAdapter(this)

    const selection = this.modelCatalogKey(cfg)
    if (this.servingRoute === cfg.route) {
      // The catalog policy or a declared modality changed without a route
      // change: re-announce the route so model pickers refresh their catalog
      // from the filtered listModels(). Settings docs that predate a field read
      // as its default.
      if (this.lastModelSelection !== null && this.lastModelSelection !== selection) {
        this.announceAdapterChange()
      }
      this.lastModelSelection = selection
      return
    }
    this.lastModelSelection = selection
    this.tryRegister()
  }

  /** A stable key for the served catalog facts: selection plus declared image models. */
  modelCatalogKey(cfg) {
    return JSON.stringify([
      cfg.modelMode ?? 'all',
      [...(cfg.models ?? [])].sort(),
      [...(cfg.imageModels ?? [])].sort(),
      Object.keys(cfg.modelCapacities ?? {}).sort(),
    ])
  }

  /**
   * The enabled-model filter: null = the whole catalog, otherwise the Set of
   * explicitly selected ids. Tolerates undefined fields from pre-feature
   * settings documents.
   */
  modelSelection() {
    const cfg = this.current()
    if (cfg.modelMode !== 'custom' || !Array.isArray(cfg.models) || cfg.models.length === 0) return null
    return new Set(cfg.models)
  }

  /** Re-announce the current route so adapters-updated listeners refresh catalogs. */
  announceAdapterChange() {
    if (this.registration === null || this.servingRoute === null) return
    try {
      this.registration.replace([this.servingRoute])
    } catch (error) {
      this.logger?.warn?.(`[opencode-suite] catalog re-announce failed: ${messageOf(error)}`)
    }
  }

  /**
   * Register (or atomically re-route) the pool adapter. A conflicting route
   * leaves the previous registration serving and records the refusal; the
   * `llm/adapters-updated` subscription retries after every topology commit,
   * so removing the opencode-go row under Settings → Models hands the route to
   * this plugin automatically.
   */
  tryRegister() {
    const route = this.current().route
    if (this.servingRoute === route) return
    try {
      if (this.registration === null) {
        this.registration = this.ctx.llm.registerAdapter([route], this.poolAdapter)
      } else {
        this.registration.replace([route])
      }
      this.servingRoute = route
      this.lastTakeoverError = null
      this.logger?.info?.(`[opencode-suite] serving provider route "${route}"`)
    } catch (error) {
      this.lastTakeoverError = messageOf(error)
      this.logger?.warn?.(`[opencode-suite] route "${route}" unavailable: ${this.lastTakeoverError};`
        + ' waiting for the owning plugin to release it')
    }
  }

  takeoverState() {
    if (this.servingRoute === DEFAULT_ROUTE) return 'serving'
    if (this.servingRoute === ALT_ROUTE) return 'own-route'
    return 'waiting'
  }

  // ---- credentials & adapters ----------------------------------------------

  /** Per-attempt adapter bound to one key: no cross-attempt key races. */
  makeAttemptAdapter(entry) {
    return new PiAiAdapter({
      profiles: () => this.profileMap,
      auth: this.auth,
      resolveApiKey: () => this.resolveKeyValue(entry),
      resolveAttachments: () => this.ctx.get('attachments'),
    })
  }

  /** Resolve one key's credential reference through the credentials seam. */
  async resolveKeyValue(entry) {
    const credentials = this.ctx.get('credentials')
    const ref = credentialRef(entry.apiKeyEnv)
    let hit
    if (credentials) {
      try {
        hit = (await credentials.resolve(ref))?.value
      } catch {
        hit = undefined
      }
    }
    if (!hit || hit.length === 0) {
      throw new LlmError(
        `opencode-suite: no credential for key "${entry.id}" (${entry.apiKeyEnv}) — store it through the`
        + ' credentials service (the card writes it) or export it',
        'MISSING_CREDENTIAL',
      )
    }
    return assertUsableApiKey(hit, 'opencode-suite', ref)
  }

  /** The active key's literal secret when resolvable, else undefined (best-effort). */
  async optionalActiveKey() {
    try {
      const entry = this.pool.currentKey()
      if (!entry) return undefined
      return await this.resolveKeyValue(entry)
    } catch {
      return undefined
    }
  }

  // ---- catalog -------------------------------------------------------------

  /** Live listing cache key for one tier. */
  listingKey(tierId) {
    return `listing:${tierId}`
  }

  /**
   * One tier's live model listing, resolved through the llm-pi-ai discovery
   * contract when it is available (it resolves the route's stored credential),
   * with a direct fetch as the fallback. Cached for LISTING_CACHE_TTL_MS with
   * in-flight dedupe, so the card's poll and a tool call share one request.
   * @param tierId - 'free' or 'go'.
   * @param signal - caller cancellation.
   * @param {object} [options]
   * @param {boolean} [options.fresh] - bypass the cache.
   */
  async tierListing(tierId, signal, { fresh = false } = {}) {
    const key = this.listingKey(tierId)
    if (fresh) this.listingCache.invalidate(key)
    return await this.listingCache.get(key, () => this.fetchTierListing(tierId, signal))
  }

  /** Uncached listing fetch; see {@link tierListing}. */
  async fetchTierListing(tierId, signal) {
    const tier = TIERS[tierId]
    const cfg = this.current()
    const baseURL = tierId === 'go'
      ? (cfg.modelsBaseUrl || DEFAULT_MODELS_BASE_URL)
      : (cfg.freeModelsBaseUrl || DEFAULT_FREE_MODELS_BASE_URL)
    // ONE definition of "what is online", shared by the watch, the drift view
    // and the adopt action: the direct fetch, exactly as refreshModels does it.
    // Preferring llm.discoverModels here made the watch read a SMALLER set than
    // the one a fetch brings in — 27 ids against 44 on the same endpoint — so a
    // model the provider had just added was invisible to the notice while being
    // visible in the model list. Discovery is now only the fallback for when the
    // direct fetch yields nothing.
    const apiKey = tierId === 'go' ? await this.optionalActiveKey() : undefined
    const direct = await fetchModelListings({
      baseUrl: baseURL,
      apiKey,
      timeoutMs: cfg.timeoutMs,
      fetchImpl: this.fetchModelsImpl,
    })
    if (direct.length > 0) return direct
    const llm = this.ctx.get('llm')
    if (llm && typeof llm.discoverModels === 'function') {
      try {
        const discovered = await llm.discoverModels(
          SETTINGS_NS,
          { provider: tier.route, baseURL, api: tier.api },
          signal,
        )
        const parsed = parseListing(Array.isArray(discovered) ? discovered : [])
        if (parsed.length > 0) return parsed
      } catch (error) {
        this.logger?.debug?.(`[opencode-suite] discovery for "${tier.route}" failed`
          + ` (${messageOf(error)}); the direct listing was empty too`)
      }
    }
    return direct
  }

  /**
   * Synthesized pi-ai descriptors for the fetched models not present in the
   * shipped catalog. The wrapper provider appends these to getModels().
   */
  dynamicModelDescriptors(route) {
    const capacities = this.current().modelCapacities ?? {}
    return Array.from(this.dynamicModels.get(route) ?? [], ({ id, name }) => (
      dynamicModelDescriptor(id, name, route, capacitiesFor(id, capacities))
    ))
  }

  /** The static (shipped) catalog ids, for detecting newly-fetched models. */
  staticModelIds() {
    return new Set(this.staticModelInputs().keys())
  }

  /** Shipped-catalog modalities by model id; empty when the catalog fails to load. */
  staticModelInputs() {
    try {
      return new Map(opencodeGoProvider().getModels().map(model => [model.id, [...model.input]]))
    } catch {
      return new Map()
    }
  }

  /** Persist the fetched-model cache (best-effort). */
  persistDynamicModels() {
    saveModelsCache(dshHomePath(MODELS_CACHE_FILE), this.dynamicModels)
  }

  /**
   * The capacities the route will actually use for each catalog model, read
   * from the provider's own descriptors.
   *
   * `LlmModelInfo` carries no capacity fields — the harness only learns a
   * model's context window and output cap from `resolveModel()` — so a card
   * that wants to show them for the whole catalog would need one round-trip per
   * model. Reading the descriptors directly answers the same question
   * synchronously, and it answers the question that matters: these are the
   * numbers the profile wrapper will serve, overrides applied.
   * @param route - provider route id.
   * @returns id → `{contextWindow, maxTokens}`, catalog models first.
   */
  catalogDescriptorCapacities(route) {
    const out = new Map()
    try {
      for (const model of opencodeGoProvider().getModels()) {
        out.set(model.id, {
          contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : null,
          maxTokens: typeof model.maxTokens === 'number' ? model.maxTokens : null,
        })
      }
    } catch {
      // Catalog unavailable: fall through to whatever the fetched cache knows.
    }
    // A fetched id that is ALSO shipped keeps the catalog's own descriptor: the
    // profile wrapper never lets a synthesized descriptor shadow a shipped one.
    for (const model of this.dynamicModelDescriptors(route)) {
      if (!out.has(model.id)) out.set(model.id, { contextWindow: model.contextWindow, maxTokens: model.maxTokens })
    }
    return out
  }

  /**
   * The card-facing model selector data: catalog entries plus enabled flags.
   * @param cfg - the resolved settings section.
   */
  async listAvailableModels(cfg) {
    const route = this.profileRoute ?? cfg.route
    let catalog = []
    try {
      if (this.innerCatalog) catalog = await this.innerCatalog.listModels(route)
    } catch {
      catalog = []
    }
    const selection = cfg.modelMode === 'custom' && Array.isArray(cfg.models) ? new Set(cfg.models) : null
    // The shipped modalities ride along so the card can tell a declaration
    // apart from the catalog's own answer and write only the difference.
    const shipped = this.staticModelInputs()
    const fetched = new Set((this.dynamicModels.get(route) ?? []).map(entry => entry.id))
    const capacities = cfg.modelCapacities ?? {}
    const served = this.catalogDescriptorCapacities(route)
    return catalog.map(entry => {
      const descriptor = served.get(entry.id)
      return {
        id: entry.id,
        name: entry.name ?? entry.id,
        enabled: selection === null || selection.has(entry.id),
        dynamic: fetched.has(entry.id),
        inputs: Array.isArray(entry.inputModalities) ? [...entry.inputModalities] : [],
        catalogInputs: shipped.get(entry.id) ?? (fetched.has(entry.id) ? ['text'] : []),
        contextWindow: descriptor?.contextWindow ?? null,
        maxTokens: descriptor?.maxTokens ?? null,
        // Where those numbers came from: an explicit override for a fetched
        // model, the documented default for one nobody has corrected, or the
        // catalog's own answer for a shipped model.
        capacitySource: fetched.has(entry.id)
          ? capacitiesFor(entry.id, capacities).source
          : (descriptor === undefined ? null : 'catalog'),
      }
    })
  }

  // ---- tier management (shared by the tools and the card) ------------------

  /**
   * One tier's model report: what is configured, what is live, and the drift.
   *
   * The Go tier is served by this plugin's pooled adapter, so its "configured"
   * answer is the pooled catalog policy (which catalog ids are exposed) rather
   * than an llm-pi-ai models list, and its `stale` set is fetched ids the
   * supplier has delisted. The free tier is an ordinary llm-pi-ai route and
   * reports the configured-vs-live drift of its `models` array.
   * @param tierId - 'free' or 'go'.
   * @param signal - caller cancellation.
   */
  async modelTierReport(tierId, signal) {
    const tier = TIERS[tierId]
    const report = {
      tier: tierId,
      route: tier.route,
      baseURL: tier.baseURL,
      routeExists: true,
      configuredCount: 0,
      liveCount: 0,
      added: [],
      stale: [],
      assumedCapacityIds: [],
      configured: [],
      error: null,
    }
    if (tierId === 'go') {
      const cfg = this.current()
      const catalog = await this.listAvailableModels(cfg)
      const exposed = catalog.filter(entry => entry.enabled)
      report.configuredCount = exposed.length
      report.configured = exposed.map(entry => entry.id)
      report.assumedCapacityIds = catalog
        .filter(entry => entry.capacitySource === 'default')
        .map(entry => entry.id)
      try {
        const live = await this.tierListing('go', signal)
        report.liveCount = live.length
        const known = new Set(catalog.map(entry => entry.id))
        report.added = live.filter(entry => !known.has(entry.id)).map(entry => entry.id)
        const liveIds = new Set(live.map(entry => entry.id))
        report.stale = (this.dynamicModels.get(tier.route) ?? [])
          .filter(entry => !liveIds.has(entry.id))
          .map(entry => entry.id)
      } catch (error) {
        report.error = messageOf(error)
      }
      return report
    }

    const settings = this.ctx.get('settings')
    if (!settings) throw new FreeTierError('the settings service is unavailable', 'NO_SETTINGS')
    const configured = readRouteModels(settings, tier.route)
    report.routeExists = configured.exists
    report.configuredCount = configured.models.length
    report.configured = configured.models.map(entry => entry.id)
    try {
      const live = filterFreeTierLive(await this.tierListing('free', signal), report.configured)
      report.liveCount = live.length
      const drift = diffEntries(configured.models, live)
      report.added = drift.added
      report.stale = drift.stale
    } catch (error) {
      report.error = messageOf(error)
    }
    return report
  }

  /**
   * Add models to one tier.
   * @param tierId - 'free' or 'go'.
   * @param {object} request
   * @param {string[]} request.ids - live listing ids to adopt.
   * @param {object[]} request.models - fully specified entries.
   * @param {boolean} request.assumeDefaults
   * @param {AbortSignal} [request.signal]
   */
  async addTierModels(tierId, { ids, models, assumeDefaults, signal }) {
    const tier = TIERS[tierId]
    if (tier === undefined) throw new FreeTierError(`unknown tier "${String(tierId)}"`, 'UNKNOWN_TIER')
    const live = await this.tierListing(tierId, signal)
    const liveById = new Map(live.map(entry => [entry.id, entry]))
    const rejected = []
    const accepted = []
    const assumed = []

    for (const raw of models) {
      const result = normalizeEntry(raw, { assumeDefaults })
      if (result.ok) {
        if (raw.contextWindow === undefined && raw.maxTokens === undefined) assumed.push(result.entry.id)
        accepted.push(result.entry)
      } else {
        rejected.push({ id: typeof raw?.id === 'string' ? raw.id : '(no id)', reason: result.errors.join('; ') })
      }
    }

    const sibling = await this.siblingListing(tierId, signal)
    for (const id of ids) {
      const found = liveById.get(id)
      if (found === undefined) {
        if (sibling.has(id)) {
          rejected.push({
            id,
            reason: `not in the ${tierId}-tier listing but present in the ${tierId === 'free' ? 'Go' : 'free'}-tier listing;`
              + ' the two tiers serve different ids — do not cross tiers',
          })
        } else {
          rejected.push({
            id,
            reason: 'not in the current live listing; pass a full `models` entry to add it unverified',
          })
        }
        continue
      }
      const hasCapacities = typeof found.contextWindow === 'number' && typeof found.maxTokens === 'number'
      if (!hasCapacities && !assumeDefaults) {
        rejected.push({
          id,
          reason: 'the listing does not disclose capacities; pass contextWindow/maxTokens via `models`,'
            + ' or set assumeDefaults: true',
        })
        continue
      }
      accepted.push({
        id,
        name: typeof found.name === 'string' && found.name.length > 0 ? found.name : id,
        contextWindow: hasCapacities ? found.contextWindow : this.assumedFor(tierId).contextWindow,
        maxTokens: hasCapacities ? found.maxTokens : this.assumedFor(tierId).maxTokens,
        input: ['text'],
      })
      if (!hasCapacities) assumed.push(id)
    }

    if (accepted.length === 0) {
      return {
        tier: tierId,
        route: tier.route,
        addedIds: [],
        skippedIds: [],
        assumedCapacityIds: [],
        assumedContextWindow: this.assumedFor(tierId).contextWindow,
        assumedMaxTokens: this.assumedFor(tierId).maxTokens,
        rejected,
        mode: null,
        revision: undefined,
        ...(rejected.length > 0 ? {} : { error: 'nothing to add after filtering' }),
      }
    }

    if (tierId === 'go') {
      return await this.adoptPooledModels(tier, accepted, assumed, rejected)
    }

    const settings = this.ctx.get('settings')
    if (!settings) throw new FreeTierError('the settings service is unavailable', 'NO_SETTINGS')
    const current = readRouteModels(settings, tier.route)
    const { merged, addedIds, skippedIds } = mergeEntries(current.models, accepted)
    const assumedDefaults = this.assumedFor(tierId)
    if (addedIds.length === 0) {
      return {
        tier: tierId,
        route: tier.route,
        addedIds,
        skippedIds,
        assumedCapacityIds: [],
        assumedContextWindow: assumedDefaults.contextWindow,
        assumedMaxTokens: assumedDefaults.maxTokens,
        rejected,
        mode: null,
        revision: describeRevision(settings),
      }
    }
    const revision = await writeRouteModels(settings, tier.route, merged)
    return {
      tier: tierId,
      route: tier.route,
      addedIds,
      skippedIds,
      // Report the assumptions this write actually landed, not the request's.
      assumedCapacityIds: assumed.filter(id => addedIds.includes(id)),
      assumedContextWindow: assumedDefaults.contextWindow,
      assumedMaxTokens: assumedDefaults.maxTokens,
      rejected,
      mode: null,
      revision,
    }
  }

  /** The documented assumed capacities for a tier's adoption path. */
  assumedFor(tierId) {
    return tierId === 'go'
      ? { contextWindow: capacitiesFor('', {}).contextWindow, maxTokens: capacitiesFor('', {}).maxTokens }
      : { contextWindow: ASSUMED_CONTEXT_WINDOW, maxTokens: ASSUMED_MAX_TOKENS }
  }

  /** The sibling tier's live ids, for the cross-tier id refusal. */
  async siblingListing(tierId, signal) {
    const other = TIER_IDS.find(id => id !== tierId)
    try {
      return new Set((await this.tierListing(other, signal)).map(entry => entry.id))
    } catch {
      return new Set()
    }
  }

  /**
   * Adopt accepted entries into the pooled catalog: register the real numbers
   * as capacity overrides, mark the ids as fetched, and make sure they are
   * exposed (switching to `custom` only when the operator has already narrowed
   * the catalog, so an "all" deployment stays "all").
   *
   * A capacity the caller did not supply is NOT written to `modelCapacities`.
   * The synthesized descriptor already falls back to the documented default, so
   * persisting that default as if it were configured would erase the only
   * signal distinguishing "somebody told us this" from "we guessed" — and would
   * silently clobber a correction made on an earlier pass.
   */
  async adoptPooledModels(tier, accepted, assumed, rejected) {
    const cfg = this.current()
    const route = tier.route
    const cached = this.dynamicModels.get(route) ?? []
    const cachedBefore = new Set(cached.map(entry => entry.id))
    const shipped = this.staticModelIds()
    const assumedSet = new Set(assumed)
    const nextCache = [...cached]
    const addedIds = []
    const skippedIds = []
    for (const entry of accepted) {
      if (cachedBefore.has(entry.id) || shipped.has(entry.id)) {
        skippedIds.push(entry.id)
        continue
      }
      nextCache.push({ id: entry.id, name: entry.name })
      addedIds.push(entry.id)
    }
    this.dynamicModels.set(route, nextCache)

    const capacities = { ...(cfg.modelCapacities ?? {}) }
    const assumedCapacityIds = []
    const assumedDefaults = this.assumedFor('go')
    for (const entry of accepted) {
      if (assumedSet.has(entry.id)) {
        // Adopted on the documented defaults; leave any existing override alone.
        assumedCapacityIds.push(entry.id)
        continue
      }
      // A shipped id keeps the catalog's own capacities unless it arrived
      // through the fetched cache, where the deployment declared its own.
      if (shipped.has(entry.id) && !cachedBefore.has(entry.id)) continue
      capacities[entry.id] = { contextWindow: entry.contextWindow, maxTokens: entry.maxTokens }
    }
    this.persistDynamicModels()

    // Exposure: 'all' already covers a new catalog id, so only a narrowed
    // catalog has to be widened — and the operator asked for these models.
    const images = [...new Set([
      ...(cfg.imageModels ?? []),
      ...accepted.filter(entry => entry.input.includes('image')).map(entry => entry.id),
    ])]
    const patch = { modelCapacities: capacities }
    if (JSON.stringify(images) !== JSON.stringify(cfg.imageModels ?? [])) patch.imageModels = images
    await this.writeSection(patch)
    const mode = this.current().modelMode
    this.announceAdapterChange()

    return {
      tier: tier.id,
      route,
      addedIds,
      skippedIds,
      assumedCapacityIds,
      assumedContextWindow: assumedDefaults.contextWindow,
      assumedMaxTokens: assumedDefaults.maxTokens,
      rejected,
      mode,
      revision: undefined,
    }
  }

  /**
   * Remove models from one tier.
   * @param tierId - 'free' or 'go'.
   * @param {string[]} ids - ids to drop.
   */
  async removeTierModels(tierId, ids) {
    const tier = TIERS[tierId]
    if (tier === undefined) throw new FreeTierError(`unknown tier "${String(tierId)}"`, 'UNKNOWN_TIER')
    if (tierId === 'free') {
      const settings = this.ctx.get('settings')
      if (!settings) throw new FreeTierError('the settings service is unavailable', 'NO_SETTINGS')
      const current = readRouteModels(settings, tier.route)
      const { merged, removedIds, notFoundIds } = removeEntries(current.models, ids)
      if (removedIds.length === 0) {
        return { tier: tierId, route: tier.route, removedIds, notFoundIds, mode: null, revision: describeRevision(settings) }
      }
      const revision = await writeRouteModels(settings, tier.route, merged)
      return { tier: tierId, route: tier.route, removedIds, notFoundIds, mode: null, revision }
    }

    // Pooled route: it has no separate per-model list to trim. Hiding ids means
    // switching the catalog policy to `custom` with exactly what stays exposed.
    const cfg = this.current()
    const catalog = await this.listAvailableModels(cfg)
    const known = new Set(catalog.map(entry => entry.id))
    const removedIds = ids.filter(id => known.has(id))
    const notFoundIds = ids.filter(id => !known.has(id))
    if (removedIds.length === 0) {
      return { tier: tierId, route: tier.route, removedIds, notFoundIds, mode: cfg.modelMode, revision: undefined }
    }
    const drop = new Set(removedIds)
    const keep = catalog.filter(entry => entry.enabled && !drop.has(entry.id)).map(entry => entry.id)
    if (keep.length === 0) {
      throw new FreeTierError(
        'removing these ids would leave the pooled catalog exposing nothing; at least one model has to stay enabled',
        'EMPTY_SELECTION',
      )
    }
    await this.writeSection({ modelMode: 'custom', models: keep })
    this.announceAdapterChange()
    return { tier: tierId, route: tier.route, removedIds, notFoundIds, mode: 'custom', revision: undefined }
  }

  /**
   * Preview or apply one tier's drift against the live listing.
   * @param tierId - 'free' or 'go'.
   * @param {object} request
   * @param {boolean} request.apply
   * @param {boolean} request.pruneStale
   * @param {AbortSignal} [request.signal]
   */
  async syncTier(tierId, { apply, pruneStale, signal }) {
    const report = {
      tier: tierId,
      planAdd: [],
      planRemove: [],
      appliedAdd: [],
      appliedRemove: [],
      assumedCapacityIds: [],
      mode: null,
      error: null,
      error2: null,
    }
    const preview = await this.modelTierReport(tierId, signal)
    if (preview.error !== null) {
      report.error = preview.error
      return report
    }
    report.planAdd = preview.added
    report.planRemove = preview.stale
    if (!apply || (preview.added.length === 0 && (!pruneStale || preview.stale.length === 0))) {
      report.mode = tierId === 'go' ? this.current().modelMode : null
      return report
    }
    try {
      if (preview.added.length > 0) {
        const result = await this.addTierModels(tierId, {
          ids: preview.added,
          models: [],
          assumeDefaults: true,
          signal,
        })
        report.appliedAdd = result.addedIds
        report.assumedCapacityIds = result.assumedCapacityIds
        if (result.mode !== null && result.mode !== undefined) report.mode = result.mode
      }
      if (pruneStale && preview.stale.length > 0) {
        const result = await this.removeTierModels(tierId, preview.stale)
        report.appliedRemove = result.removedIds
        if (result.mode !== null && result.mode !== undefined) report.mode = result.mode
      }
      if (report.mode === null && tierId === 'go') report.mode = this.current().modelMode
    } catch (error) {
      report.error2 = messageOf(error)
    }
    return report
  }

  // ---- Typert Remote surface (the card) ------------------------------------

  /** Pull the latest Go lineup from the official endpoint and merge it in. */
  async refreshModels() {
    const cfg = this.current()
    const baseUrl = cfg.modelsBaseUrl || DEFAULT_MODELS_BASE_URL
    // The endpoint is public, but pass the active key's credential when one is
    // resolvable (account-specific lineups); a missing key must not block.
    const apiKey = await this.optionalActiveKey()
    const fetched = await fetchModelListings({
      baseUrl,
      apiKey,
      timeoutMs: cfg.timeoutMs,
      fetchImpl: this.fetchModelsImpl,
    })
    const route = this.profileRoute ?? cfg.route
    const known = this.staticModelIds()
    const before = new Set((this.dynamicModels.get(route) ?? []).map(entry => entry.id))
    const added = []
    const cache = [...(this.dynamicModels.get(route) ?? [])]
    const seen = new Set(cache.map(entry => entry.id))
    for (const model of fetched) {
      if (!known.has(model.id) && !before.has(model.id)) added.push(model.id)
      if (seen.has(model.id)) {
        // Refresh the display name of one already cached.
        const index = cache.findIndex(entry => entry.id === model.id)
        if (index >= 0) cache[index] = { id: model.id, name: model.name || model.id }
        continue
      }
      seen.add(model.id)
      cache.push({ id: model.id, name: model.name || model.id })
    }
    this.dynamicModels.set(route, cache)
    this.persistDynamicModels()
    this.listingCache.invalidate(this.listingKey('go'))
    // Refresh any model picker that cached the catalog from listModels().
    this.announceAdapterChange()
    return {
      count: fetched.length,
      models: fetched.map(model => ({ id: model.id, name: model.name || model.id })),
      added,
      fetchedAt: new Date().toISOString(),
    }
  }

  async status() {
    const cfg = this.current()
    // A reader counts as a clock: whoever looks after a restart gets a check
    // now, not after the interval. Not awaited, so a page load never waits on
    // two listing endpoints.
    if (this.modelWatchDue()) void this.checkModels()
    const fetchedAt = new Date().toISOString()
    const entries = this.pool.entries()
    const availableModels = await this.listAvailableModels(cfg)
    const usageResults = await Promise.all(entries.map(async entry => {
      try {
        const key = await this.resolveKeyValue(entry)
        const usage = await this.usageCache.get(entry.id, () => fetchUsage({
          baseUrl: cfg.usageBaseUrl,
          apiKey: key,
          timeoutMs: cfg.timeoutMs,
        }))
        this.pool.onUsage(entry.id, usage)
        return { id: entry.id, usage, usageError: null, fetchedAt, credentialSet: true }
      } catch (error) {
        const code = error && error.code ? error.code : 'network'
        return {
          id: entry.id,
          usage: null,
          usageError: code === 'MISSING_CREDENTIAL' ? 'no-api-key' : code,
          fetchedAt: null,
          credentialSet: code !== 'MISSING_CREDENTIAL',
        }
      }
    }))
    const freeTier = await this.freeTier()
    const sessionCfg = this.sessionConfig()
    return {
      takeover: this.takeoverState(),
      route: this.servingRoute ?? cfg.route,
      usageRefreshMs: cfg.usageRefreshMs,
      preemptAtPercent: cfg.preemptAtPercent,
      switchAfterConsecutiveFailures: cfg.switchAfterConsecutiveFailures,
      modelMode: cfg.modelMode ?? 'all',
      availableModels,
      modelCapacities: Object.fromEntries(
        Object.entries(cfg.modelCapacities ?? {}).map(([id, value]) => [id, { ...value }]),
      ),
      activeId: this.pool.activeId,
      usableCount: this.pool.usableCount(),
      lastSwitch: this.pool.lastSwitch,
      takeoverHint: this.servingRoute ? null : this.lastTakeoverError,
      keys: entries.map(entry => {
        const st = this.pool.stateOf(entry.id)
        const result = usageResults.find(item => item.id === entry.id)
        return {
          id: entry.id,
          label: entry.label,
          apiKeyEnv: entry.apiKeyEnv,
          state: st.state,
          active: entry.id === this.pool.activeId,
          usage: (result && result.usage) ?? null,
          usageError: (result && result.usageError) ?? null,
          fetchedAt: (result && result.fetchedAt) ?? null,
          credentialSet: (result && result.credentialSet) ?? false,
          lastFailure: st.lastFailure ?? null,
        }
      }),
      freeTier,
      modelWatch: await this.modelWatchReport(),
      // The card's own reading of the Config, so a write that silently failed
      // shows up here rather than as a control that appears to do nothing.
      usageLogEnabled: this.current().usageLogEnabled !== false,
      usageLogSource: this.current().usageLogSource === 'log' ? 'log' : 'live',
      imNotify: {
        enabled: this.current().notifyImEnabled === true,
        botId: this.current().notifyImBotId ?? '',
        targetId: this.current().notifyImTargetId ?? '',
      },
      sessionHeaders: {
        enabled: sessionCfg.enabled,
        providers: [...sessionCfg.providers],
        hosts: [...sessionCfg.hosts],
        baseURLs: [...sessionCfg.baseURLs],
        headers: [...sessionCfg.headers],
        extraHeaders: { ...sessionCfg.extraHeaders },
        userAgent: sessionCfg.userAgent,
        nanoidSessionId: sessionCfg.nanoidSessionId,
        nanoidLength: sessionCfg.nanoidLength,
        nanoidAlphabet: sessionCfg.nanoidAlphabet,
        seedSessionId: sessionCfg.seedSessionId,
        verbose: sessionCfg.verbose,
        injected: this.injectionLog.entries.length,
        recent: this.injectionLog.list(),
      },
    }
  }

  /**
   * Per-day, per-model token accounting, for the card and the agent tool.
   *
   * A refresh sweeps the changed sessions under the configured budget and then
   * reports the requested window, so the answer carries its own completeness:
   * `sweep.complete` false means more sessions are still queued, not that the
   * numbers are wrong.
   *
   * The window arrives POSITIONALLY: the gateway validates the wire fields and
   * then calls this method with the resolved values in declared order, so an
   * object parameter here would be a number and `days` would silently stay
   * undefined.
   * @param days - the window to report; omitted or invalid falls back to the configured one.
   * @returns the window payload, with `error` naming why it is empty.
   */
  async usageBreakdown(days) {
    const cfg = this.current()
    const source = cfg.usageLogSource === 'log' ? 'log' : 'live'
    const retention = Number.isSafeInteger(cfg.usageLogRetentionDays) && cfg.usageLogRetentionDays > 0
      ? cfg.usageLogRetentionDays
      : DEFAULT_RETENTION_DAYS
    const configured = Number.isSafeInteger(cfg.usageLogWindowDays) && cfg.usageLogWindowDays > 0
      ? cfg.usageLogWindowDays
      : DEFAULT_WINDOW_DAYS
    const windowDays = Number.isSafeInteger(days) && days > 0 ? Math.min(days, retention) : configured
    const empty = this.usageLedger.snapshot({ windowDays, retentionDays: retention })
    if (cfg.usageLogEnabled === false) {
      return { ...empty, source, enabled: false, error: 'local token accounting is disabled (usageLogEnabled)' }
    }
    if (source === 'live') {
      return { ...empty, source, enabled: true, error: null }
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined || persistence === null) {
      return { ...empty, source, enabled: true, error: 'the sessionPersistence service is unavailable in this profile' }
    }
    try {
      await this.usageLedger.refresh(persistence, {
        sessionsPerSweep: cfg.usageLogSessionsPerSweep,
        maxMs: cfg.usageLogSweepMaxMs,
        retentionDays: retention,
      })
    } catch (error) {
      return {
        ...this.usageLedger.snapshot({ windowDays, retentionDays: retention }),
        source,
        enabled: true,
        error: messageOf(error),
      }
    }
    return {
      ...this.usageLedger.snapshot({ windowDays, retentionDays: retention }),
      source,
      enabled: true,
      error: null,
    }
  }

  async setActive(id) {
    this.pool.setActive(id)
    return true
  }

  /**
   * The agent-facing pool action, batched behind one entry point so the tool
   * surface stays small. Every branch reports what it did in the operator's
   * terms, because the model reading the result has no other window into the
   * pool.
   * @param action - one of `switch`, `disable`, `enable`, `clear-invalid`, `clear-exhausted`.
   * @param keyId - the pool key id.
   * @throws {Error} naming the key or the action when either is unknown.
   */
  async poolAction(action, keyId) {
    const id = String(keyId)
    if (!this.pool.entries().some(entry => entry.id === id)) {
      throw new Error(`unknown key "${id}" — run oc_suite_status to list the pool`)
    }
    switch (action) {
      case 'switch':
        this.pool.setActive(id)
        return { ok: true, message: `key "${id}" is now the active key` }
      case 'disable':
        this.pool.setDisabled(id, true)
        return { ok: true, message: `key "${id}" is disabled and no longer selected` }
      case 'enable':
        this.pool.setDisabled(id, false)
        return { ok: true, message: `key "${id}" is enabled and back in the rotation` }
      case 'clear-invalid':
        this.pool.clearInvalid(id)
        return { ok: true, message: `the invalid mark on "${id}" is cleared` }
      case 'clear-exhausted':
        this.pool.clearExhausted(id)
        return { ok: true, message: `the exhausted mark on "${id}" is cleared` }
      default:
        throw new Error(`unknown action "${String(action)}"`)
    }
  }

  async setDisabled(id, on) {
    this.pool.setDisabled(id, on)
    return true
  }

  async clearInvalid(id) {
    this.pool.clearInvalid(id)
    return true
  }

  async clearExhausted(id) {
    this.pool.clearExhausted(id)
    return true
  }

  async putKeys(keys) {
    assertKeyList(keys)
    await this.writeSection({ keys })
    return true
  }

  /**
   * Store one key's literal secret through the credentials seam under its
   * configured reference name. The secret never enters settings, logs, or any
   * response — the same carrier and trust domain the Models page uses when it
   * writes credentials.
   */
  async putKeySecret(id, secret) {
    const entry = this.pool.entries().find(item => item.id === id)
    if (!entry) throw new Error(`unknown key "${id}"`)
    if (typeof secret !== 'string' || secret.trim().length === 0) {
      throw new Error(`key "${id}" needs a non-empty secret`)
    }
    const credentials = this.ctx.get('credentials')
    if (!credentials || typeof credentials.set !== 'function') {
      throw new Error('no credentials service is mounted — set the key through the credentials page instead')
    }
    const ref = credentialRef(entry.apiKeyEnv)
    const usable = assertUsableApiKey(secret.trim(), 'opencode-suite', ref)
    await credentials.set(ref, usable)
    // A freshly supplied secret may repair an invalid-marked key.
    this.pool.clearInvalid(id)
    this.usageCache.invalidate(id)
    return true
  }

  /** Update the card-visible pool and catalog settings (never keys). */
  /**
   * Write Config fields the card owns.
   *
   * The patch goes to the settings service as it arrives: that service validates
   * it against this plugin's LIVE Config schema, including the volatile-field
   * rule, so a new Config field works the moment it is declared and a typo is
   * refused by name. Re-deriving the field list here is what made a card
   * control fail with "no known fields" while its Config field existed — the
   * three lists (Config, wire codec, this method) drifted apart.
   *
   * Only the two rules a schema cannot express are enforced here: unique,
   * non-blank model ids, and a custom model selection that actually selects.
   * @param config - the fields to merge.
   * @throws {Error} naming the rule when either check fails.
   */
  async putConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('putConfig needs a plain object of Config fields')
    }
    if (Object.keys(config).length === 0) throw new Error('putConfig received an empty patch')
    const patch = { ...config }
    if (patch.models !== undefined) patch.models = assertIdList(patch.models, 'models')
    if (patch.imageModels !== undefined) patch.imageModels = assertIdList(patch.imageModels, 'imageModels')
    const effective = { ...this.current(), ...patch }
    if (effective.modelMode === 'custom'
        && (!Array.isArray(effective.models) || effective.models.length === 0)) {
      throw new Error('custom model selection needs at least one model — pick models or use modelMode "all"')
    }
    await this.writeSection(patch)
    return true
  }

  async putSessionHeaders(patch) {
    if (!patch || typeof patch !== 'object') throw new Error('putSessionHeaders needs an object')
    const candidate = { ...this.sessionConfig() }
    if (patch.enabled !== undefined) candidate.enabled = patch.enabled === true
    if (patch.verbose !== undefined) candidate.verbose = patch.verbose === true
    if (patch.seedSessionId !== undefined) candidate.seedSessionId = patch.seedSessionId === true
    if (patch.nanoidSessionId !== undefined) candidate.nanoidSessionId = patch.nanoidSessionId === true
    if (patch.disableFetchInjection !== undefined) {
      candidate.disableFetchInjection = patch.disableFetchInjection === true
    }
    if (patch.nanoidLength !== undefined) {
      const length = Number(patch.nanoidLength)
      if (!Number.isInteger(length) || length < 4 || length > 32) {
        throw new Error('nanoidLength must be an integer 4..32')
      }
      candidate.nanoidLength = length
    }
    if (patch.nanoidAlphabet !== undefined) {
      if (patch.nanoidAlphabet !== 'alphanumeric' && patch.nanoidAlphabet !== 'urlsafe') {
        throw new Error('nanoidAlphabet must be "alphanumeric" or "urlsafe"')
      }
      candidate.nanoidAlphabet = patch.nanoidAlphabet
    }
    if (patch.providers !== undefined) candidate.providers = assertIdList(patch.providers, 'providers')
    if (patch.hosts !== undefined) candidate.hosts = assertIdList(patch.hosts, 'hosts')
    if (patch.baseURLs !== undefined) candidate.baseURLs = assertIdList(patch.baseURLs, 'baseURLs')
    if (patch.headers !== undefined) candidate.headers = assertIdList(patch.headers, 'headers')
    if (patch.extraHeaders !== undefined) {
      if (patch.extraHeaders === null || typeof patch.extraHeaders !== 'object' || Array.isArray(patch.extraHeaders)) {
        throw new Error('extraHeaders must be an object of header name → string')
      }
      for (const [headerName, value] of Object.entries(patch.extraHeaders)) {
        if (typeof value !== 'string') throw new Error(`extraHeaders["${headerName}"] must be a string`)
      }
      candidate.extraHeaders = { ...patch.extraHeaders }
    }
    if (patch.userAgent !== undefined) {
      if (typeof patch.userAgent !== 'string') throw new Error('userAgent must be a string')
      candidate.userAgent = patch.userAgent
    }
    // Re-normalize so names, alphabets and lengths are validated by the same
    // function the runtime reads through — the card cannot smuggle in a header
    // name the injector would silently drop.
    const normalized = normalizeSessionConfig(candidate)
    await this.writeSection({ sessionHeaders: normalized })
    return true
  }

  async clearSessionLog() {
    this.injectionLog.clear()
    return true
  }

  /** The free tier's card data. */
  async freeTier() {
    const tier = TIERS.free
    const base = {
      tier: tier.id,
      route: tier.route,
      baseURL: tier.baseURL,
      exists: false,
      apiKeyEnv: null,
      configured: [],
      live: [],
      added: [],
      stale: [],
      revision: null,
      error: null,
    }
    const settings = this.ctx.get('settings')
    if (!settings) return { ...base, error: 'the settings service is unavailable' }
    let current
    try {
      current = readRouteModels(settings, tier.route)
      base.exists = current.exists
      base.apiKeyEnv = readRouteApiKeyEnv(settings, tier.route)
      base.revision = describeRevision(settings) ?? null
      base.configured = current.models.map(entry => ({
        id: entry.id,
        name: entry.name,
        contextWindow: typeof entry.contextWindow === 'number' ? entry.contextWindow : null,
        maxTokens: typeof entry.maxTokens === 'number' ? entry.maxTokens : null,
        input: Array.isArray(entry.input) ? [...entry.input] : [],
      }))
    } catch (error) {
      return { ...base, error: messageOf(error) }
    }
    try {
      const live = filterFreeTierLive(
        await this.tierListing('free', undefined),
        current.models.map(entry => entry.id),
      )
      base.live = live.map(entry => entry.id)
      const drift = diffEntries(current.models, live)
      base.added = drift.added
      base.stale = drift.stale
    } catch (error) {
      base.error = messageOf(error)
    }
    return base
  }

  /**
   * Replace the free tier's model list wholesale (the card's checkbox flow).
   * @param entries - the complete next list, as `{id, name?, contextWindow, maxTokens, input?}`.
   * @param assumeDefaults - fill missing capacities with the documented pair.
   */
  async putFreeTierModels(entries, assumeDefaults = false) {
    if (!Array.isArray(entries)) throw new Error('putFreeTierModels needs an array of entries')
    const settings = this.ctx.get('settings')
    if (!settings) throw new FreeTierError('the settings service is unavailable', 'NO_SETTINGS')
    if (entries.length === 0) throw new Error('the free-tier model list cannot be emptied through the card')
    const normalized = []
    const rejections = []
    for (const raw of entries) {
      const result = normalizeEntry(raw, { assumeDefaults })
      if (result.ok) normalized.push(result.entry)
      else rejections.push(`${typeof raw?.id === 'string' ? raw.id : '(no id)'}: ${result.errors.join('; ')}`)
    }
    if (rejections.length > 0) throw new Error(`refused: ${rejections.join(' | ')}`)
    const revision = await writeRouteModels(settings, TIERS.free.route, normalized)
    return { revision: revision ?? null, count: normalized.length }
  }

  async takeOverState() {
    return this.takeoverState()
  }
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

export default OpenCodeSuite
