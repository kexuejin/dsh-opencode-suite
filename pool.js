/**
 * KeyPool — pure state machine for the OpenCode Go multi-key pool.
 *
 * Deliberately free of harness imports so it runs under plain Node tests.
 * The owning plugin feeds it configuration, failure classifications, and
 * fresh usage facts; the pool owns selection, rotation, and durability.
 *
 * @module dsh-opencode-suite/pool
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Per-key lifecycle states. */
export const HEALTHY = 'healthy'
export const EXHAUSTED = 'exhausted'
export const DISABLED = 'disabled'
export const INVALID = 'invalid'
export const KEY_STATES = [HEALTHY, EXHAUSTED, DISABLED, INVALID]

/** Failure codes that rotate the pool (provider-neutral harness codes). */
export const QUOTA_CODE = 'QUOTA' // == dsh-llm QUOTA_EXCEEDED_CODE
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL'
export const AUTH_CODE = 'AUTH'

/** Rotation reasons, as persisted in `lastSwitch.reason`. */
export const ROTATION_REASONS = ['quota', 'invalid', 'consecutive', 'manual']

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Validate one pool key entry.
 * @param {unknown} entry - candidate `{ id, label, apiKeyEnv }`.
 * @throws {Error} with a human-readable message naming the offending field.
 */
export function assertKeyEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('each key entry must be an object')
  const id = entry.id
  const label = entry.label
  const apiKeyEnv = entry.apiKeyEnv
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`key id "${String(id)}" must match ${String(ID_PATTERN)}`)
  }
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new Error(`key "${id}" needs a non-empty label`)
  }
  if (typeof apiKeyEnv !== 'string' || !ENV_PATTERN.test(apiKeyEnv)) {
    throw new Error(`key "${id}" apiKeyEnv must be a credential reference name like OPENCODE_GO_KEY_A`)
  }
}

/**
 * Validate a whole key list: per-entry shape plus cross-entry uniqueness.
 * @param {unknown[]} entries - candidate key list.
 * @throws {Error} naming the first offending entry.
 */
export function assertKeyList(entries) {
  if (!Array.isArray(entries)) throw new Error('keys must be an array')
  const ids = new Set()
  const envs = new Set()
  for (const entry of entries) {
    assertKeyEntry(entry)
    if (ids.has(entry.id)) throw new Error(`duplicate key id "${entry.id}"`)
    if (envs.has(entry.apiKeyEnv)) throw new Error(`duplicate apiKeyEnv "${entry.apiKeyEnv}"`)
    ids.add(entry.id)
    envs.add(entry.apiKeyEnv)
  }
}

function isQuotaCode(code) {
  return code === QUOTA_CODE
}

/**
 * Provider error identities that name the model or the region — never the key.
 *
 * The OpenCode Zen gateway answers all of these on exactly the 401 a bad key
 * produces (`ModelError` 401, `RegionError` 403), and the harness collapses
 * every 401/403 into the single `AUTH` code, so the status alone cannot tell
 * them apart. The provider's own error identity can:
 *
 *   AuthError   401  invalid / missing API key  → a real credential fault
 *   ModelError  401  model unsupported here     → the key is innocent
 *   RegionError 403  model blocked in this country → the key is innocent
 */
const MODEL_FAULT_ERROR_TYPES = new Set([
  'modelerror', 'modelnotfound', 'model_not_found', 'unsupportedmodel',
  'regionerror', 'deprecationerror', 'policydenied',
])

/** Provider error identities that positively identify a credential fault. */
const CREDENTIAL_FAULT_ERROR_TYPES = new Set([
  'autherror', 'authenticationerror', 'invalidapikey', 'invalid_api_key', 'unauthorized',
])

/** Wording fallbacks for providers that answer without a structured error type. */
const MODEL_FAULT_TEXT = /not available in your country|unsupported_country_region|country, region, or territory|model .{0,80}?is not supported|model_not_found|no such model|not supported for format/i
const CREDENTIAL_FAULT_TEXT = /invalid api key|incorrect api key|missing api key|api key.{0,20}(?:invalid|expired|revoked|disabled)|invalid[_ ]?credentials?|unauthori[sz]ed/i

/**
 * Pull the provider's own error identity out of a harness failure message.
 * pi-ai wraps the body as `<Something> API error (<status>): {json}`, while
 * other paths hand the envelope through untouched. Accept both `{type}` and
 * `{error:{type}}` and return the lowercased type, or `''` when there is none.
 * @param {unknown} message - the failure message.
 * @returns {string} a lowercased provider error type, or an empty string.
 */
function providerErrorType(message) {
  const text = String(message ?? '')
  const start = text.indexOf('{')
  if (start < 0) return ''
  let body
  try {
    body = JSON.parse(text.slice(start))
  } catch {
    return ''
  }
  if (!body || typeof body !== 'object') return ''
  const envelope = body.error && typeof body.error === 'object' ? body.error : body
  return typeof envelope.type === 'string' ? envelope.type.toLowerCase() : ''
}

/**
 * Decide what an `AUTH`-coded failure actually means, from evidence rather than
 * from the status code the harness flattened away.
 *
 * `onFailure` may only mark a key unusable on *positive* evidence of a
 * credential fault. Treating every 401/403 as one is what let a single
 * region-blocked model mark every key invalid and dry out the whole pool, so an
 * unrecognized AUTH deliberately reports `'unknown'` and leaves the key alone.
 *
 * @param {{code?: string, message?: string}|null} failure - serializable failure facts.
 * @returns {'credential'|'model'|'unknown'|null} `null` when the code is not
 *   credential-shaped at all — the caller's transient path owns those.
 */
export function authFaultKind(failure) {
  if (!failure) return null
  const code = failure.code ? String(failure.code) : ''
  // The harness raises this one itself, after probing the value locally.
  if (code === INVALID_CREDENTIAL_CODE) return 'credential'
  if (code !== AUTH_CODE) return null
  const type = providerErrorType(failure.message)
  if (MODEL_FAULT_ERROR_TYPES.has(type)) return 'model'
  if (CREDENTIAL_FAULT_ERROR_TYPES.has(type)) return 'credential'
  const text = String(failure.message ?? '')
  if (MODEL_FAULT_TEXT.test(text)) return 'model'
  if (CREDENTIAL_FAULT_TEXT.test(text)) return 'credential'
  return 'unknown'
}

/**
 * The pool: ordered key entries, per-key lifecycle state, sticky active
 * selection, round-robin rotation on classified failures, usage-driven
 * revival, and best-effort atomic persistence to a JSON state file.
 */
export class KeyPool {
  /**
   * @param {object} [options]
   * @param {string|null} [options.stateFile] - JSON path for durable state; null disables persistence.
   * @param {number} [options.reviveThresholdPercent] - exhausted keys revive once rolling usage drops below this (default 98).
   * @param {number} [options.preemptAtPercent] - skip healthy keys whose rolling/weekly usage reached this (default 100 = never preempt).
   * @param {number} [options.consecutiveThreshold] - consecutive transient failures that rotate away from a key; 0 disables the rule.
   * @param {() => number} [options.now] - clock injection for tests.
   */
  constructor({
    stateFile = null,
    reviveThresholdPercent = 98,
    preemptAtPercent = 100,
    consecutiveThreshold = 0,
    now = () => Date.now(),
  } = {}) {
    this.stateFile = stateFile
    this.reviveThresholdPercent = reviveThresholdPercent
    this.preemptAtPercent = preemptAtPercent
    this.consecutiveThreshold = consecutiveThreshold
    this.now = now
    /** @type {Array<{id: string, label: string, apiKeyEnv: string}>} ordered key entries. */
    this.keys = []
    /** @type {Map<string, {state: string, usage: object|null, lastFailure: object|null, failureStreak: number}>} */
    this.states = new Map()
    /** @type {string|null} sticky active key id. */
    this.activeId = null
    /** @type {{from: string|null, to: string|null, reason: string, at: string}|null} */
    this.lastSwitch = null
    if (this.stateFile) this.load()
  }

  // ---- configuration -------------------------------------------------------

  setPreempt(percent) {
    this.preemptAtPercent = percent
  }

  setConsecutiveThreshold(count) {
    this.consecutiveThreshold = count
  }

  setReviveThreshold(percent) {
    this.reviveThresholdPercent = percent
  }

  /**
   * Replace the key list, keeping per-key state for ids that survive.
   * Throws on malformed entries (never leaves the pool half-updated).
   * @param {Array<{id: string, label: string, apiKeyEnv: string}>} entries
   */
  syncKeys(entries) {
    assertKeyList(entries)
    const before = new Map(this.states)
    this.keys = entries.map(entry => ({ id: entry.id, label: entry.label, apiKeyEnv: entry.apiKeyEnv }))
    this.states = new Map()
    for (const entry of this.keys) {
      const prev = before.get(entry.id)
      this.states.set(entry.id, prev ?? { state: HEALTHY, usage: null, lastFailure: null, failureStreak: 0 })
      if (this.states.get(entry.id).failureStreak === undefined) this.states.get(entry.id).failureStreak = 0
    }
    if (this.activeId !== null && !this.states.has(this.activeId)) this.activeId = null
    if (this.activeId === null || !this.isUsable(this.activeId)) {
      this.activeId = this.pickFirstUsableId()
    }
    this.persist()
  }

  // ---- reads ---------------------------------------------------------------

  keyCount() {
    return this.keys.length
  }

  /** @returns detached ordered copies of the key entries. */
  entries() {
    return this.keys.map(key => ({ ...key }))
  }

  stateOf(id) {
    return this.states.get(id) ?? { state: HEALTHY, usage: null, lastFailure: null, failureStreak: 0 }
  }

  /** A key is usable when healthy, not preempted by usage, and present. */
  isUsable(id) {
    if (!this.states.has(id)) return false
    const st = this.states.get(id)
    if (st.state !== HEALTHY) return false
    if (this.preemptAtPercent < 100 && st.usage) {
      // Preempt on EITHER window: a key whose 5h rolling window OR weekly
      // window already reached the threshold gets skipped before it fails.
      for (const window of [st.usage.rolling, st.usage.weekly]) {
        if (window && typeof window.percent === 'number'
            && window.percent >= this.preemptAtPercent) {
          return false
        }
      }
    }
    return true
  }

  pickFirstUsableId() {
    const entry = this.keys.find(key => this.isUsable(key.id))
    return entry ? entry.id : null
  }

  /** Next usable key in configuration order after `afterId` (round-robin). */
  pickNextUsableId(afterId) {
    const index = this.keys.findIndex(key => key.id === afterId)
    if (index < 0) return this.pickFirstUsableId()
    for (let step = 1; step <= this.keys.length; step++) {
      const key = this.keys[(index + step) % this.keys.length]
      if (this.isUsable(key.id)) return key.id
    }
    return null
  }

  usableCount() {
    return this.keys.filter(key => this.isUsable(key.id)).length
  }

  /**
   * The key entry selected for one model request, or null when the pool is
   * fully dry (every key exhausted/disabled/invalid/preempted).
   */
  currentKey() {
    if (this.activeId === null || !this.isUsable(this.activeId)) {
      this.activeId = this.pickFirstUsableId()
    }
    if (this.activeId === null) return null
    return this.keys.find(key => key.id === this.activeId) ?? null
  }

  // ---- mutations -----------------------------------------------------------

  /** Manually designate the active key (card "switch now"). */
  setActive(id) {
    if (!this.states.has(id)) throw new Error(`unknown key "${id}"`)
    if (!this.isUsable(id)) throw new Error(`key "${id}" is not usable right now`)
    if (this.activeId !== id) {
      this.lastSwitch = {
        from: this.activeId,
        to: id,
        reason: 'manual',
        at: new Date(this.now()).toISOString(),
      }
    }
    this.activeId = id
    this.persist()
  }

  /** Card toggle: disable removes the key from selection; enabling restores it. */
  setDisabled(id, on) {
    if (!this.states.has(id)) throw new Error(`unknown key "${id}"`)
    const st = this.states.get(id)
    st.state = on ? DISABLED : HEALTHY
    if (on && this.activeId === id) this.activeId = this.pickFirstUsableId()
    if (!on && this.activeId === null) this.activeId = this.pickFirstUsableId()
    this.persist()
  }

  /** Card action: forget an invalid mark after the user fixed the credential. */
  clearInvalid(id) {
    if (!this.states.has(id)) throw new Error(`unknown key "${id}"`)
    const st = this.states.get(id)
    if (st.state !== INVALID) return
    st.state = HEALTHY
    st.lastFailure = null
    if (this.activeId === null) this.activeId = this.pickFirstUsableId()
    this.persist()
  }

  /** Forget an exhausted mark (card action, or a credential repair). */
  clearExhausted(id) {
    if (!this.states.has(id)) throw new Error(`unknown key "${id}"`)
    const st = this.states.get(id)
    if (st.state !== EXHAUSTED) return
    st.state = HEALTHY
    st.lastFailure = null
    if (this.activeId === null) this.activeId = this.pickFirstUsableId()
    this.persist()
  }

  /**
   * Record a classified failure for the key one attempt used, rotating the
   * active key away. Quota codes mark the key exhausted; an AUTH code marks it
   * invalid only on positive evidence of a credential fault (see
   * {@link authFaultKind}); a model/region rejection rotates nothing because
   * every key would answer identically; every other code counts a transient
   * streak and rotates once the configured consecutive threshold trips.
   * @param {string} id - key id the failing attempt used.
   * @param {{code?: string, message?: string}} failure - serializable failure facts.
   * @returns {{from: string|null, to: string|null}|null} the rotation, or null when not a rotation trigger.
   */
  onFailure(id, failure) {
    if (!this.states.has(id)) return null
    const code = failure && failure.code ? String(failure.code) : ''
    const st = this.states.get(id)
    const fault = authFaultKind(failure)
    if (fault === 'model') {
      // The provider rejected the model or the region, not the credential. Every
      // key would answer identically, so rotate nothing and keep the key
      // healthy; the recorded fact still reaches the card's last-failure line.
      st.lastFailure = {
        code,
        message: String((failure && failure.message) || ''),
        at: new Date(this.now()).toISOString(),
      }
      this.persist()
      return null
    }
    const reason = isQuotaCode(code) ? 'quota' : (fault === 'credential' ? 'invalid' : null)
    if (reason === null) {
      // Transient failure (rate limit, server, timeout, …): count the streak
      // and rotate away once configured consecutive failures accumulate.
      st.failureStreak = (st.failureStreak ?? 0) + 1
      st.lastFailure = {
        code,
        message: String((failure && failure.message) || ''),
        at: new Date(this.now()).toISOString(),
      }
      if (this.consecutiveThreshold > 0 && st.failureStreak >= this.consecutiveThreshold) {
        st.failureStreak = 0
        const next = this.pickNextUsableId(id)
        if (next !== null && next !== id) {
          this.activeId = next
          this.lastSwitch = {
            from: id,
            to: next,
            reason: 'consecutive',
            at: new Date(this.now()).toISOString(),
          }
          this.persist()
          return { from: id, to: next }
        }
      }
      this.persist()
      return null
    }
    st.state = reason === 'quota' ? EXHAUSTED : INVALID
    st.failureStreak = 0
    st.lastFailure = {
      code,
      message: String((failure && failure.message) || ''),
      at: new Date(this.now()).toISOString(),
    }
    this.activeId = this.pickFirstUsableId()
    this.lastSwitch = {
      from: id,
      to: this.activeId,
      reason,
      at: new Date(this.now()).toISOString(),
    }
    this.persist()
    return { from: id, to: this.activeId }
  }

  /** A successful request resets the transient-failure streak. */
  onSuccess(id) {
    if (!this.states.has(id)) return
    const st = this.states.get(id)
    if (st.failureStreak !== 0) {
      st.failureStreak = 0
      this.persist()
    }
  }

  /**
   * Feed fresh usage facts from the official endpoint. Also revives an
   * exhausted key once its rolling window reports ok and below threshold —
   * the endpoint is the authority, never a timer guess.
   */
  onUsage(id, usage) {
    if (!this.states.has(id)) return
    const st = this.states.get(id)
    st.usage = usage ?? null
    if (st.state === EXHAUSTED
        && usage && usage.rolling
        && usage.rolling.status === 'ok'
        && typeof usage.rolling.percent === 'number'
        && usage.rolling.percent < this.reviveThresholdPercent) {
      st.state = HEALTHY
      st.lastFailure = null
      if (this.activeId === null) this.activeId = this.pickFirstUsableId()
    }
    this.persist()
  }

  // ---- durability ----------------------------------------------------------

  snapshot() {
    const states = {}
    for (const [id, st] of this.states.entries()) {
      states[id] = {
        state: st.state,
        usage: st.usage ?? null,
        lastFailure: st.lastFailure ?? null,
        failureStreak: st.failureStreak ?? 0,
      }
    }
    return { version: 1, activeId: this.activeId, lastSwitch: this.lastSwitch, states }
  }

  persist() {
    if (!this.stateFile) return
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      const tmp = `${this.stateFile}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2))
      renameSync(tmp, this.stateFile)
    } catch {
      // Persistence is best-effort: losing the active-selection/state file
      // costs only a re-selection, never a failed request.
    }
  }

  load() {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      if (!raw || typeof raw !== 'object' || raw.version !== 1) return
      if (typeof raw.activeId === 'string') this.activeId = raw.activeId
      if (raw.lastSwitch && typeof raw.lastSwitch === 'object') this.lastSwitch = raw.lastSwitch
      if (raw.states && typeof raw.states === 'object') {
        for (const [id, st] of Object.entries(raw.states)) {
          if (!st || typeof st !== 'object') continue
          const lastFailure = st.lastFailure ?? null
          let state = KEY_STATES.includes(st.state) ? st.state : HEALTHY
          // A persisted `invalid` mark records the failure that caused it, so it
          // can be re-judged. Builds that classified on the status code alone
          // marked a key invalid for a model or region rejection, poisoning the
          // pool permanently; honour only marks the evidence still supports, and
          // let a genuinely bad key be re-marked on its next request.
          if (state === INVALID && authFaultKind(lastFailure) !== 'credential') state = HEALTHY
          this.states.set(id, {
            state,
            usage: st.usage ?? null,
            lastFailure,
            failureStreak: typeof st.failureStreak === 'number' ? st.failureStreak : 0,
          })
        }
      }
    } catch {
      // Missing or corrupt state file: start fresh.
    }
  }
}
