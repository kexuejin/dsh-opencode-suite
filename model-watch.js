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
  return { seeded: false, seen: [], names: {}, pending: {}, renamed: {}, gone: {} }
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
    const names = {}
    for (const [id, name] of Object.entries(raw.names ?? {})) {
      if (typeof id === 'string' && typeof name === 'string') names[id] = name
    }
    const renamed = {}
    for (const [id, entry] of Object.entries(raw.renamed ?? {})) {
      if (entry !== null && typeof entry === 'object' && typeof entry.from === 'string' && typeof entry.to === 'string') {
        renamed[id] = { from: entry.from, to: entry.to, at: typeof entry.at === 'string' ? entry.at : '' }
      }
    }
    state[tier] = { seeded: raw.seeded === true, seen: normalizeIds(raw.seen), names, pending, renamed, gone }
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
  /**
   * Fold one tier's live listing into the state.
   *
   * Entries are `{id, name}`; a bare string is accepted so callers that only
   * carry ids keep working. A model that was already seen under a DIFFERENT
   * display name is a rename, which is news in its own right — a provider
   * renaming a model is how a user learns its capabilities moved.
   * @param {string} tierId - `go` or `free`.
   * @param {Array<{id: string, name?: string}|string>} entries - the live listing.
   * @returns `{added, renamed, gone, first}`.
   */
  observe(tierId, entries) {
    const tier = this.state[tierId] ?? emptyTier()
    this.state[tierId] = tier
    const at = new Date(this.now()).toISOString()
    const live = entries.map(entry => (typeof entry === 'string' ? { id: entry, name: null } : {
      id: entry?.id,
      name: typeof entry?.name === 'string' && entry.name.length > 0 ? entry.name : null,
    })).filter(entry => typeof entry.id === 'string' && entry.id.length > 0)
    const liveIds = live.map(entry => entry.id)
    // The first pass over a tier is its baseline: adopt whatever is online
    // without announcing it. That is what a fresh install, a state file that
    // could not be read, and a restart after the file was deleted all look
    // like, and none of them is news.
    if (!tier.seeded) {
      tier.seeded = true
      tier.seen = [...new Set(liveIds)]
      for (const entry of live) if (entry.name !== null) tier.names[entry.id] = entry.name
      return { added: [], renamed: [], gone: [], first: true }
    }
    // `seen` is the previous listing, not a union: an id that left and came
    // back is new again, which is what makes the return trip announceable.
    const previous = new Set(tier.seen)
    const present = new Set(liveIds)
    const added = []
    const renamed = []
    for (const entry of live) {
      if (!previous.has(entry.id)) {
        if (tier.pending[entry.id] === undefined) tier.pending[entry.id] = at
        added.push(entry.id)
      } else if (entry.name !== null) {
        const before = tier.names[entry.id]
        // No recorded name means this state predates name tracking (or the
        // listing carried none); recording it is not a rename.
        if (before !== undefined && before !== entry.name) {
          if (tier.renamed[entry.id] === undefined) tier.renamed[entry.id] = { from: before, to: entry.name, at }
          renamed.push(entry.id)
        }
        tier.names[entry.id] = entry.name
      }
    }
    const gone = []
    for (const id of previous) {
      if (present.has(id)) continue
      gone.push(id)
      if (tier.gone[id] === undefined) tier.gone[id] = at
    }
    // A model that came back is no longer gone, and is no longer "renamed" to
    // whatever it was called before it left.
    for (const id of Object.keys(tier.gone)) {
      if (present.has(id)) delete tier.gone[id]
    }
    tier.seen = [...present]
    return { added, renamed, gone, first: false }
  }

  /**
   * Drop one tier's notices, keeping what it has seen.
   *
   * Only the notice goes: the seen set stays, so a dismissed id is not
   * re-announced until it leaves and comes back.
   * @param {string} tierId - `go` or `free`.
   * @returns {number} how many pending ids were dropped.
   */
  acknowledge(tierId) {
    const tier = this.state[tierId] ?? emptyTier()
    const dropped = Object.keys(tier.pending).length + Object.keys(tier.renamed).length
    tier.pending = {}
    tier.renamed = {}
    tier.gone = {}
    this.save()
    return dropped
  }

  /**
   * Adopt a tier's current listing as the baseline and drop what it announced.
   *
   * The escape hatch for a baseline that was taken from the wrong source: the
   * ids it produced are real but not new, and only a person can say "this is
   * what is online now, start counting from here".
   * @param {string} tierId - `go` or `free`.
   * @param {string[]} liveIds - the listing to adopt.
   * @returns {number} how many pending ids were dropped.
   */
  reseed(tierId, liveIds) {
    const tier = this.state[tierId] ?? emptyTier()
    const dropped = Object.keys(tier.pending).length + Object.keys(tier.gone).length
    tier.seeded = true
    tier.seen = [...new Set(liveIds)]
    tier.pending = {}
    tier.gone = {}
    this.state[tierId] = tier
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

  /** The ids whose display name changed, oldest notice first. */
  renamed(tierId) {
    const tier = this.state[tierId]
    if (tier === undefined) return []
    return Object.entries(tier.renamed)
      .sort((a, b) => a[1].at.localeCompare(b[1].at))
      .map(([id, entry]) => ({ id, from: entry.from, to: entry.to, firstSeenAt: entry.at }))
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
      tiers[tierId] = {
        pending: this.pending(tierId),
        renamed: this.renamed(tierId),
        gone: this.gone(tierId),
        online: this.state[tierId]?.seen.length ?? 0,
        // The ids the endpoint serves, so a caller can intersect that with what
        // the profile actually exposes instead of re-fetching the listing.
        onlineIds: [...(this.state[tierId]?.seen ?? [])],
      }
    }
    return {
      enabled,
      intervalMs,
      lastCheckedAt: this.lastCheckedAt,
      error: this.lastError,
      pendingTotal: this.pendingCount(),
      tiers,
      seeded: WATCHED_TIERS.every(tierId => this.state[tierId]?.seeded === true),
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
          const outcome = this.observe(tierId, liveIds)
          notices.push(...outcome.added.map(id => `${tierId}:${id}`))
          notices.push(...outcome.renamed.map(id => `${tierId}:${id} (renamed)`))
        }
        this.lastCheckedAt = new Date(this.now()).toISOString()
        this.lastError = failure
        // EVERY pass persists, baseline included. Saving only on news left a
        // silent deployment with no file at all, so neither the baseline nor the
        // time of the last check could be read back from disk.
        this.save()
        return { notices }
      })
      .finally(() => { this.running = undefined })
    this.running = promise
    return promise
  }
}
