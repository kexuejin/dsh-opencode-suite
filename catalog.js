/**
 * Model-catalog helpers for the OpenCode suite.
 *
 * Two tiers, two listing endpoints, ids only:
 *
 *   GET <modelsURL>          free: https://opencode.ai/zen/v1/models
 *                            go:   https://opencode.ai/zen/go/v1/models
 *   Authorization: Bearer <apiKey>   (optional — both endpoints are public)
 *
 * Response (OpenAI-compatible, undocumented for Go):
 *   { "object": "list", "data": [ { "id": "deepseek-v4-pro", "object": "model",
 *                                   "created": 1787845562, "owned_by": "opencode" } ] }
 *
 * Neither listing discloses context windows, output caps, modalities, or
 * reasoning levels, and limited-time models get delisted, so this module owns
 * four things: the tier table, entry normalization against the harness'
 * model-entry schema, drift computation (online-not-configured /
 * delisted-but-configured), and the synthesized pi-ai descriptor a fetched
 * model needs to become routable on the pooled route.
 *
 * Harness-free on purpose: the same functions back the host tools, the browser
 * card, and plain `node --test`.
 *
 * @module dsh-opencode-suite/catalog
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The settings namespace whose `providers` section owns the two routes. */
export const SETTINGS_NS = 'llm-pi-ai'

/**
 * The two OpenCode Zen tiers, per the official endpoint layout: the free tier
 * serves `-free`-suffixed ids at `zen/v1`, the Go tier serves unsuffixed ids at
 * `zen/go/v1`. The routes carry the names llm-pi-ai uses as provider keys.
 */
export const TIERS = {
  free: {
    id: 'free',
    route: 'opencode',
    label: 'OpenCode Zen 免费档',
    labelEn: 'OpenCode Zen Free',
    baseURL: 'https://opencode.ai/zen/v1',
    modelsURL: 'https://opencode.ai/zen/v1/models',
    api: 'openai-completions',
  },
  go: {
    id: 'go',
    route: 'opencode-go',
    label: 'OpenCode Zen Go',
    labelEn: 'OpenCode Zen Go',
    baseURL: 'https://opencode.ai/zen/go/v1',
    modelsURL: 'https://opencode.ai/zen/go/v1/models',
    api: 'openai-completions',
  },
}

/** Tier ids in presentation order. */
export const TIER_IDS = ['free', 'go']

/** Map a provider route name back to its tier, or undefined when unmanaged. */
export function tierByRoute(route) {
  return TIER_IDS.map(id => TIERS[id]).find(tier => tier.route === route)
}

/**
 * Capacity values applied when a caller adopts live listing ids without
 * declaring them (the free-tier path writes full entries into llm-pi-ai, so it
 * has to invent something). Deliberately conservative; every entry filled this
 * way is reported back so the real figures can replace them.
 */
export const ASSUMED_CONTEXT_WINDOW = 128000
export const ASSUMED_MAX_TOKENS = 32000

/**
 * Defaults for a synthesized descriptor on the pooled route. Higher than the
 * assumed pair above because the pooled catalog mirrors the shipped Go catalog
 * family (DeepSeek long-context rows), and a wrong guess here only affects
 * context filing and output caps, never whether a request is accepted.
 */
export const DEFAULT_CONTEXT_WINDOW = 1000000
export const DEFAULT_MAX_TOKENS = 131072

/** Modalities a model entry may declare; the pi-ai adapter supports these two. */
export const INPUT_MODALITIES = ['text', 'image']

/** Reasoning-effort levels the llm-pi-ai schema accepts as dict keys. */
export const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Official free-tier model ids: every row the OpenCode Zen docs pricing table
 * prices "Free" (`Free` / `Free` / `Free` / `-`), verified 2026-09-14 against
 * <https://opencode.ai/docs/zen/>. All six are confirmed present in the live
 * free listing (`https://opencode.ai/zen/v1/models`, 70 ids, all public).
 *
 * The endpoint cannot answer this question for us: `zen/v1/models` discloses
 * ids only, so 6 of its 70 ids are free and the other 64 are pay-as-you-go.
 * "Free" is therefore a *per-model price attribute*, not a property of the
 * route and not a grant of free usage — see the tier doc comment in this file.
 *
 * Two traps this list exists to encode:
 * - A `-free` suffix does NOT imply free-of-charge. `big-pickle` is a free
 *   stealth model with no suffix, while `deepseek-v4-flash-free` and
 *   `muse-spark-1.2-contributor-free` carry the suffix but are absent from the
 *   pricing table. Only table rows are adopted; suffix-only ids are not.
 * - The free set rotates. Upstream delists entries (there is a "Deprecated
 *   models" table) and replaces limited-time models with successors
 *   (`muse-spark-1.2-contributor-free` → `muse-spark-1.3-contributor-free`).
 *   Re-verify this constant against the docs when free-tier drift looks wrong;
 *   ids a deployment configured by hand always survive `filterFreeTierLive`.
 */
export const OFFICIAL_FREE_MODEL_IDS = [
  'big-pickle',
  'mimo-v2.5-free',
  'ling-3.0-flash-fin-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'muse-spark-1.3-contributor-free',
]

/**
 * Request modalities a synthesized descriptor declares by default. The listing
 * reports ids only, so a fetched model reads as text-only until the deployment
 * declares image input through the plugin's `imageModels`.
 */
export const DYNAMIC_MODEL_INPUT = Object.freeze(['text'])

/** On-disk shape version of the fetched-lineup cache. */
export const MODELS_CACHE_VERSION = 1

/** Coded failure for one models query; `code` is a stable machine key. */
export class CatalogError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * Derive a display name from a model id: split on separators, capitalize
 * words, keep version digits intact (`x-preview-f-free` → `X Preview F Free`).
 * @param id - the model id.
 * @returns a human-readable fallback name.
 */
export function displayNameFromId(id) {
  return String(id)
    .split(/[-_]+/)
    .filter(part => part.length > 0)
    .map(part => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
}

/** Alias kept for callers that read the name as "title case an id". */
export const titleCaseId = displayNameFromId

/* ------------------------------------------------------------------ *
 * Live listing
 * ------------------------------------------------------------------ */

/**
 * Query one listing endpoint once.
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} [options.apiKey] - optional; sent as Bearer when present.
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pid] - process id stamped into the request id header.
 * @param {Function} [options.fetchImpl] - injectable fetch for tests.
 * @returns {Promise<Array<{id: string, name: string}>>}
 * @throws {CatalogError} with codes: network | unauthorized | http-<status> | bad-json
 */
export async function fetchModelListings({ baseUrl, apiKey, timeoutMs = 15000, pid, fetchImpl }) {
  const impl = fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const headers = {
    Accept: 'application/json',
    'x-client-request-id': `dsh-opencode-suite-${pid ?? process.pid}`,
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  let res
  try {
    res = await impl(baseUrl, { headers, signal: controller.signal })
  } catch {
    throw new CatalogError('network', `models request failed: ${baseUrl}`)
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 401) {
    throw new CatalogError('unauthorized', 'models endpoint rejected the key (401)')
  }
  if (!res.ok) {
    throw new CatalogError(`http-${res.status}`, `models endpoint answered HTTP ${res.status}`)
  }
  let body
  try {
    body = await res.json()
  } catch {
    throw new CatalogError('bad-json', 'models endpoint answered with non-JSON')
  }
  return parseListing(body)
}

/**
 * Normalize any listing body shape into `{id, name}` pairs, in endpoint order.
 * Accepts a bare array, an OpenAI `{data:[…]}` envelope, and bare id strings.
 * @param body - the decoded JSON body.
 * @returns deduplicated listing entries.
 */
export function parseListing(body) {
  const raw = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : [])
  const seen = new Set()
  const models = []
  for (const item of raw) {
    const entry = typeof item === 'string'
      ? { id: item, name: displayNameFromId(item) }
      : (item && typeof item === 'object' && typeof item.id === 'string'
        ? { id: item.id, name: typeof item.name === 'string' && item.name.length > 0 ? item.name : displayNameFromId(item.id) }
        : null)
    if (entry === null || entry.id.length === 0 || seen.has(entry.id)) continue
    seen.add(entry.id)
    models.push(entry)
  }
  return models
}

/* ------------------------------------------------------------------ *
 * Entry normalization (the free tier writes these into llm-pi-ai)
 * ------------------------------------------------------------------ */

/**
 * Normalize one caller-supplied models entry against the llm-pi-ai schema.
 * @param raw - the draft entry (id required; everything else checked).
 * @param options - when `assumeDefaults` is set, missing positive capacity
 *   numbers fall back to the documented assumptions instead of failing.
 * @returns `{ ok: true, entry }` or `{ ok: false, errors }`.
 */
export function normalizeEntry(raw, { assumeDefaults = false } = {}) {
  const errors = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['entry must be an object'] }
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id.length === 0) errors.push('id is required')
  let name
  if (raw.name === undefined || raw.name === null || String(raw.name).trim() === '') {
    name = id.length > 0 ? displayNameFromId(id) : undefined
  } else if (typeof raw.name === 'string') {
    name = raw.name.trim()
  } else {
    errors.push('name must be a string')
  }

  let contextWindow
  if (raw.contextWindow === undefined || raw.contextWindow === null) {
    if (assumeDefaults && id.length > 0) contextWindow = ASSUMED_CONTEXT_WINDOW
    else errors.push('contextWindow is required (a positive integer), or set assumeDefaults')
  } else if (Number.isInteger(raw.contextWindow) && raw.contextWindow > 0) {
    contextWindow = raw.contextWindow
  } else {
    errors.push('contextWindow must be a positive integer')
  }

  let maxTokens
  if (raw.maxTokens === undefined || raw.maxTokens === null) {
    if (assumeDefaults && id.length > 0) maxTokens = ASSUMED_MAX_TOKENS
    else errors.push('maxTokens is required (a positive integer), or set assumeDefaults')
  } else if (Number.isInteger(raw.maxTokens) && raw.maxTokens > 0) {
    maxTokens = raw.maxTokens
  } else {
    errors.push('maxTokens must be a positive integer')
  }

  let input
  if (raw.input === undefined || raw.input === null) {
    input = ['text']
  } else if (Array.isArray(raw.input) && raw.input.every(m => INPUT_MODALITIES.includes(m))) {
    input = raw.input.length > 0 ? [...raw.input] : ['text']
  } else {
    errors.push(`input must be a non-empty array drawn from ${JSON.stringify(INPUT_MODALITIES)}`)
  }

  let reasoningEfforts
  if (raw.reasoningEfforts === undefined || raw.reasoningEfforts === null) {
    reasoningEfforts = undefined
  } else if (raw.reasoningEfforts === false) {
    reasoningEfforts = false
  } else if (typeof raw.reasoningEfforts === 'object' && !Array.isArray(raw.reasoningEfforts)) {
    const efforts = {}
    for (const [level, spelling] of Object.entries(raw.reasoningEfforts)) {
      if (!EFFORT_LEVELS.includes(level)) {
        errors.push(`reasoningEfforts level "${level}" is not one of ${EFFORT_LEVELS.join(', ')}`)
        continue
      }
      if (spelling !== null && spelling !== undefined && typeof spelling !== 'string') {
        errors.push(`reasoningEfforts.${level} must be a string or null`)
        continue
      }
      efforts[level] = spelling === undefined ? null : spelling
    }
    if (Object.keys(efforts).length > 0) reasoningEfforts = efforts
    else if (errors.length === 0) reasoningEfforts = false
  } else {
    errors.push('reasoningEfforts must be false, an object of level → wire spelling, or omitted')
  }

  if (errors.length > 0 || name === undefined) {
    return { ok: false, errors: errors.length > 0 ? errors : ['name could not be derived'] }
  }
  const entry = { id, name, contextWindow, maxTokens, input }
  if (reasoningEfforts !== undefined) entry.reasoningEfforts = reasoningEfforts
  return { ok: true, entry }
}

/* ------------------------------------------------------------------ *
 * Config-list assertions shared by the settings schema and the RPC surface
 * ------------------------------------------------------------------ */

/**
 * Normalize a caller-supplied string list: trimmed, de-duplicated, order kept.
 * A non-list value or a blank / non-string entry is refused rather than
 * silently dropped, because the same list doubles as an allow-list.
 * @param value - the list the caller sent.
 * @param field - field name used in the error message.
 * @returns the normalized list.
 */
export function assertIdList(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings`)
  for (const id of value) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error(`${field} must contain only non-empty strings`)
    }
  }
  return [...new Set(value.map(id => id.trim()))]
}

/* ------------------------------------------------------------------ *
 * Drift / merge / remove
 * ------------------------------------------------------------------ */

/**
 * Compare one route's configured entries with its live listing.
 * @param configured - configured entries (at least `id` each).
 * @param live - discovered entries (at least `id` each).
 * @returns `added` (live but not configured) and `stale` (configured but no
 *   longer listed) as arrays of ids, in listing/configured order.
 */
export function diffEntries(configured, live) {
  const configuredIds = new Set(configured.map(entry => entry.id))
  const liveIds = new Set(live.map(entry => entry.id))
  return {
    added: live.filter(entry => !configuredIds.has(entry.id)).map(entry => entry.id),
    stale: configured.filter(entry => !liveIds.has(entry.id)).map(entry => entry.id),
  }
}

/** Alias matching the "diff models" reading. */
export const diffModels = diffEntries

/**
 * Merge normalized entries into an existing models list. Existing ids win:
 * adopting a candidate never overwrites a capacity someone corrected.
 * @param existing - the route's current models array.
 * @param additions - normalized entries to add.
 * @returns `{ merged, addedIds, skippedIds }`.
 */
export function mergeEntries(existing, additions) {
  const known = new Set(existing.map(entry => entry.id))
  const merged = [...existing]
  const addedIds = []
  const skippedIds = []
  for (const entry of additions) {
    if (known.has(entry.id)) {
      skippedIds.push(entry.id)
      continue
    }
    known.add(entry.id)
    merged.push(entry)
    addedIds.push(entry.id)
  }
  return { merged, addedIds, skippedIds }
}

/**
 * Remove entries by id from one route's models list.
 * @param existing - the route's current models array.
 * @param ids - ids to drop.
 * @returns `{ merged, removedIds, notFoundIds }`.
 */
export function removeEntries(existing, ids) {
  const drop = new Set(ids)
  const removedIds = []
  const merged = existing.filter(entry => {
    if (!drop.has(entry.id)) return true
    removedIds.push(entry.id)
    return false
  })
  const notFoundIds = ids.filter(id => !removedIds.includes(id))
  return { merged, removedIds, notFoundIds }
}

/**
 * A free-tier live entry is one the official docs price as Free, or an id this
 * deployment already configured (stays managed, never flagged delisted).
 * Paid ids ride the free listing too; they must never count, drift or adopt.
 * @param live - the free listing as returned.
 * @param configuredIds - ids already configured on the free route.
 */
export function filterFreeTierLive(live, configuredIds) {
  const keep = new Set(OFFICIAL_FREE_MODEL_IDS.concat(configuredIds || []))
  return live.filter(entry => keep.has(entry.id))
}

/**
 * Build the deep-merge patch that replaces exactly one route's models array.
 * Sibling routes and every other key of the target route survive the merge.
 * @param route - the provider route key (`opencode` / `opencode-go`).
 * @param models - the complete next models array.
 */
export function buildRoutePatch(route, models) {
  return { providers: { [route]: { models } } }
}

/* ------------------------------------------------------------------ *
 * Synthesized descriptors for the pooled route
 * ------------------------------------------------------------------ */

/** Where a synthesized descriptor's capacities came from. */
export const CAPACITY_SOURCE = {
  configured: 'configured',
  default: 'default',
}

/**
 * Resolve one synthesized model's capacities: an explicit per-id override
 * wins, otherwise the documented defaults. Returns the numbers plus which
 * source answered, so the card can flag every assumed value by name.
 * @param id - model id.
 * @param overrides - `{ [id]: { contextWindow, maxTokens } }`.
 */
export function capacitiesFor(id, overrides) {
  const hit = overrides ? overrides[id] : undefined
  if (hit && Number.isFinite(hit.contextWindow) && Number.isFinite(hit.maxTokens)) {
    return { contextWindow: hit.contextWindow, maxTokens: hit.maxTokens, source: CAPACITY_SOURCE.configured }
  }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, source: CAPACITY_SOURCE.default }
}

/**
 * Synthesize a routable pi-ai model descriptor for a fetched model the shipped
 * catalog does not know. The protocol / endpoint / reasoning shape are
 * best-effort defaults mirroring the dominant Go catalog family
 * (DeepSeek-style openai-completions): the same reasoning levels as
 * deepseek-v4-pro (off/high/max), so the thinking-strength control behaves like
 * the shipped models. Known models are never synthesized.
 *
 * `cost` is always present and zero: the pi-ai usage pipeline calls
 * `calculateCost()` on every completed stream and iterates
 * `model.cost.tiers`, so a descriptor without a cost block crashes the whole
 * round with "Cannot read properties of undefined (reading 'tiers')"
 * (PI_AI_ERROR). Supplier-new models publish no per-token pricing.
 *
 * @param id - model id.
 * @param name - display name (falls back to a derived one).
 * @param route - provider route id (e.g. opencode-go).
 * @param capacities - `{ contextWindow, maxTokens }` for this id.
 */
export function dynamicModelDescriptor(id, name, route, capacities) {
  const window = capacities?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const maxTokens = capacities?.maxTokens ?? DEFAULT_MAX_TOKENS
  return {
    id,
    name: name || displayNameFromId(id),
    provider: route,
    api: 'openai-completions',
    baseUrl: TIERS.go.baseURL,
    input: [...DYNAMIC_MODEL_INPUT],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Mirror deepseek-v4-pro: getSupportedThinkingLevels() yields
    // [off, high, max], and the deepseek thinking format serializes
    // thinking + reasoning_effort on the wire.
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
    },
    contextWindow: window,
    maxTokens,
  }
}

/**
 * One descriptor with this deployment's declared image capability applied.
 *
 * `input` is what the harness reports as `inputModalities`, and both the
 * `read_image` tool and the session input gate refuse images for a model that
 * does not declare them, so this declaration is what makes a vision-capable
 * gateway model usable. The descriptor is copied because the pi-ai catalog
 * objects are shared with every other consumer of the same provider.
 * @param model - one descriptor from the catalog or a synthesized one.
 * @param imageModels - model ids declared to accept image input.
 * @returns the descriptor, or a copy declaring image input.
 */
export function withDeclaredInput(model, imageModels) {
  if (!Array.isArray(model.input) || model.input.includes('image') || !imageModels.includes(model.id)) {
    return model
  }
  return { ...model, input: [...model.input, 'image'] }
}

/* ------------------------------------------------------------------ *
 * Fetched-lineup cache
 * ------------------------------------------------------------------ */

/**
 * Load the persisted fetched-lineup cache: `{ route: [{id, name}] }`.
 * @param path
 * @returns a Map of route → entries; empty on any failure.
 */
export function loadModelsCache(path) {
  const out = new Map()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || typeof raw !== 'object') return out
    const routes = raw.version === MODELS_CACHE_VERSION && raw.routes && typeof raw.routes === 'object'
      ? raw.routes
      : null
    if (routes === null) return out
    for (const [route, entries] of Object.entries(routes)) {
      if (!Array.isArray(entries)) continue
      out.set(route, entries
        .filter(entry => entry && typeof entry.id === 'string')
        .map(entry => ({ id: entry.id, name: typeof entry.name === 'string' ? entry.name : entry.id })))
    }
  } catch {
    // Missing or corrupt cache: start fresh.
  }
  return out
}

/**
 * Persist the fetched-lineup cache (best-effort atomic write).
 * @param path
 * @param cache - Map of route → `[{id, name}]`.
 */
export function saveModelsCache(path, cache) {
  try {
    const routes = {}
    for (const [route, entries] of cache.entries()) routes[route] = entries
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: MODELS_CACHE_VERSION, routes }, null, 2))
    renameSync(tmp, path)
  } catch {
    // Persistence is best-effort: losing the fetched cache only costs a re-fetch.
  }
}
