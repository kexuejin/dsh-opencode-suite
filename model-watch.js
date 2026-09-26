/**
 * The model watcher: what is online that the profile has not adopted yet.
 *
 * The suite already knows how to diff a tier's live listing against what the
 * profile exposes (`modelTierReport`), but only when somebody asks — a card
 * poll or a tool call. A model that ships overnight is therefore invisible
 * until a human happens to open the page. This module is the part that does not
 * wait: it takes a pair of listings, remembers what it has already reported,
 * and hands back what is new and what disappeared.
 *
 * The state is deliberately small and plain — a last-seen id set and a pending
 * set per tier, each with the moment it was first noticed — so it survives a
 * restart as one JSON file and the card can render "new since 3 days ago"
 * instead of re-announcing the same id every poll.
 *
 * @module dsh-opencode-suite/model-watch
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The tiers this watcher follows. */
export const WATCHED_TIERS = ['go', 'free']

const STATE_VERSION = 1

function emptyTier() {
  return { seeded: false, seen: [], pending: {}, gone: {} }
}

function normalizeIds(value) {
  return Array.isArray(value) ? value.filter(id => typeof id === 'string' && id.length > 0) : []
}

/** `{go, free}` from a persisted document, with anything malformed dropped. */
function readState(document) {
  const state = { version: STATE_VERSION, go: emptyTier(), free: emptyTier() }
  if (document === null || typeof document !== 'object' || document.version !== STATE_VERSION) return state
  for (const tier of WATCHED_TIERS) {
    const raw = document[tier]
    if (raw === null || typeof raw !== 'object') continue
    const pending = {}
    for (const [id, at] of Object.entries(raw.pending ?? {})) {
      if (typeof id === 'string' && id.length > 0 && typeof at === 'string') pending[id] = at
    }
    const gone = {}
    for (const [id, at] of Object.entries(raw.gone ?? {})) {
      if (typeof id === 'string' && id.length > 0 && typeof at === 'string') gone[id] = at
    }
    state[tier] = { seeded: raw.seeded === true, seen: normalizeIds(raw.seen), pending, gone }
  }
  return state
}

/**
 * Tracks the online listings of both tiers and reports the difference.
 */
export class ModelWatcher {
  /**
   * @param {object} [options]
   * @param {string} [options.statePath] - where the state file lives; omitted means in-memory only.
   * @param {() => number} [options.now] - clock injection for tests.
   */
  constructor({ statePath, now = () => Date.now() } = {}) {
    this.statePath = statePath
    this.now = now
    this.state = this.load()
    this.lastCheckedAt = null
    this.lastError = null
    this.running = undefined
  }

  /** Read the state file, tolerating a missing or corrupt one. */
  load() {
    if (this.statePath === undefined) return readState(null)
    try {
      return readState(JSON.parse(readFileSync(this.statePath, 'utf8')))
    } catch {
      return readState(null)
    }
  }

  /** Write the state file (best-effort atomic write). */
  save() {
    if (this.statePath === undefined) return
    try {
      mkdirSync(dirname(this.statePath), { recursive: true })
      const tmp = `${this.statePath}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, this.statePath)
    } catch {
      // Best effort: a missing state file only costs one round of re-announcing.
    }
  }

  /**
   * Fold one tier's live listing into the state.
   * @param {string} tierId - `go` or `free`.
   * @param {string[]} liveIds - the ids the endpoint serves right now.
   * @returns {{added: string[], gone: string[], first: boolean}} what this pass noticed.
   */
  observe(tierId, liveIds) {
    const tier = this.state[tierId] ?? emptyTier()
    this.state[tierId] = tier
    const at = new Date(this.now()).toISOString()
    // The first pass over a tier is its baseline: adopt whatever is online
    // without announcing it. That is what a fresh install, a state file that
    // could not be read, and a restart after the file was deleted all look
    // like, and none of them is news.
    if (!tier.seeded) {
      tier.seeded = true
      tier.seen = [...new Set(liveIds)]
      return { added: [], gone: [], first: true }
    }
    // `seen` is the previous listing, not a union: an id that left and came
    // back is new again, which is what makes the return trip announceable.
    const previous = new Set(tier.seen)
    const live = new Set(liveIds)
    const added = []
    for (const id of liveIds) {
      if (previous.has(id)) continue
      if (tier.pending[id] === undefined) tier.pending[id] = at
      added.push(id)
    }
    const gone = []
    for (const id of previous) {
      if (live.has(id)) continue
      gone.push(id)
      if (tier.gone[id] === undefined) tier.gone[id] = at
    }
    // A model that came back is no longer gone.
    for (const id of Object.keys(tier.gone)) {
      if (live.has(id)) delete tier.gone[id]
    }
    tier.seen = [...new Set(liveIds)]
    return { added, gone, first: false }
  }

  /**
   * Drop a tier's pending and gone sets — the card's "dismiss" action.
   * @param {string} tierId - `go` or `free`.
   * @returns {number} how many pending ids were dropped.
   */
  acknowledge(tierId) {
    const tier = this.state[tierId] ?? emptyTier()
    const dropped = Object.keys(tier.pending).length
    tier.pending = {}
    tier.gone = {}
    this.save()
    return dropped
  }

  /** The ids a tier is still announcing, oldest notice first. */
  pending(tierId) {
    const tier = this.state[tierId]
    if (tier === undefined) return []
    return Object.entries(tier.pending)
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, firstSeenAt]) => ({ id, firstSeenAt }))
  }

  /** The ids that left a tier's listing, oldest notice first. */
  gone(tierId) {
    const tier = this.state[tierId]
    if (tier === undefined) return []
    return Object.entries(tier.gone)
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, firstSeenAt]) => ({ id, firstSeenAt }))
  }

  /** How many ids are waiting across every tier. */
  pendingCount() {
    return WATCHED_TIERS.reduce((total, tierId) => total + this.pending(tierId).length, 0)
  }

  /**
   * The wire report: what a card or a tool renders.
   * @returns {object} per-tier news plus the last check.
   */
  report({ enabled = true, intervalMs = 0 } = {}) {
    const tiers = {}
    for (const tierId of WATCHED_TIERS) {
      tiers[tierId] = { pending: this.pending(tierId), gone: this.gone(tierId), online: this.state[tierId]?.seen.length ?? 0 }
    }
    return {
      enabled,
      intervalMs,
      lastCheckedAt: this.lastCheckedAt,
      error: this.lastError,
      pendingTotal: this.pendingCount(),
      tiers,
    }
  }

  /**
   * Run one watch pass over both tiers. Concurrent callers share it, so an
   * interval tick and a card's manual check never double-fetch.
   * @param {(tierId: string) => Promise<string[]>} listIds - the caller's listing reader.
   * @returns {Promise<{notices: string[]}>} the ids that were new this pass.
   */
  async check(listIds) {
    if (this.running !== undefined) return this.running
    const promise = Promise.resolve()
      .then(async () => {
        const notices = []
        let failure = null
        for (const tierId of WATCHED_TIERS) {
          let liveIds
          try {
            liveIds = await listIds(tierId)
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error)
            continue
          }
          notices.push(...this.observe(tierId, liveIds).added.map(id => `${tierId}:${id}`))
        }
        this.lastCheckedAt = new Date(this.now()).toISOString()
        this.lastError = failure
        if (notices.length > 0 || failure !== null) this.save()
        return { notices }
      })
      .finally(() => { this.running = undefined })
    this.running = promise
    return promise
  }
}
