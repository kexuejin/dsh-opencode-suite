/**
 * Local token accounting: how much each model spent, per day.
 *
 * The Go usage endpoint answers one question only — how much of the plan
 * window is spent — and it answers it per key, never per model and never as a
 * token count. So "which model is expensive" cannot come from there, and this
 * module is where that answer is produced instead. Two sources feed one set of
 * day buckets, and a deployment picks one (a call both sources see would be
 * counted twice):
 *
 *  - **live**: the suite already intercepts `llm/stream` to scope session
 *    headers, so the same pass reads each request's own usage report and folds
 *    it as the turn ends. No reads, no sweep, correct immediately.
 *  - **log**: the `sessionPersistence` seam reads the durable session log —
 *    `assistant/message` events carry the model and the provider's usage — so
 *    history from before the plugin was on is counted too, without this plugin
 *    learning the log's storage format (a multi-frame zstd artifact the host
 *    owns).
 *
 * The log path is incremental in both directions: a remembered `revision`
 * change token skips a log that did not move, and a remembered `offset` turns a
 * grown log into a tail read. One refresh is bounded by a session count and a
 * wall clock, fastest-growing first, and reports what is still queued rather
 * than blocking a caller on a thousand-session store.
 *
 * Day keys are local calendar days, so "today" means the user's today.
 *
 * @module dsh-opencode-suite/usage-log
 */

/** Day buckets kept before the oldest is dropped. */
export const DEFAULT_RETENTION_DAYS = 90
/** Days a snapshot reports unless the caller asks for another window. */
export const DEFAULT_WINDOW_DAYS = 7
/** Changed sessions one refresh may open. */
export const DEFAULT_SESSIONS_PER_SWEEP = 12
/** Wall-clock one refresh may spend folding, so a caller never waits on a big store. */
export const DEFAULT_SWEEP_MAX_MS = 4000
/** Events one session read may return; a longer log continues on the next sweep. */
const READ_PAGE = 5000
/** Consecutive fold failures after which a session stops being retried. */
const FAILURE_LIMIT = 3

/** Token fields summed per call; absent ones count as zero. */
const TOKEN_FIELDS = [
  ['input', 'inputTokens'],
  ['output', 'outputTokens'],
  ['cacheRead', 'cacheReadTokens'],
  ['cacheWrite', 'cacheWriteTokens'],
  ['reasoning', 'reasoningTokens'],
]

/**
 * The local calendar day of an event timestamp, as `YYYY-MM-DD`.
 *
 * Local, not UTC: "today" has to mean the user's today, and a session that
 * starts at 00:30 belongs to the day they are looking at.
 * @param {number} time - epoch milliseconds.
 * @returns {string} the `YYYY-MM-DD` local day key.
 */
export function dayKeyOf(time) {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function emptyRow() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

function addRow(target, source) {
  target.calls += source.calls
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.reasoning += source.reasoning
  return target
}

/** The three buckets a caller sees, with the derived total. */
function publish(row) {
  const total = row.input + row.output + row.cacheRead + row.cacheWrite + row.reasoning
  return { ...row, total }
}

/** Fold one counted call into a day bucket. */
function foldCall(days, { provider, model, usage, time }) {
  const key = `${provider ?? 'unknown'}/${model}`
  const day = dayKeyOf(time)
  let models = days.get(day)
  if (models === undefined) {
    models = new Map()
    days.set(day, models)
  }
  let row = models.get(key)
  if (row === undefined) {
    row = emptyRow()
    models.set(key, row)
  }
  row.calls += 1
  for (const [field, source_key] of TOKEN_FIELDS) {
    const value = usage[source_key]
    if (typeof value === 'number' && Number.isFinite(value)) row[field] += value
  }
}

/**
 * Fold one log event into a day bucket, ignoring everything that is not a model
 * answer carrying a usage record.
 * @param {Map<string, Map<string, object>>} days - day key -> model key -> row.
 * @param {object} event - one session log event.
 */
function foldEvent(days, event) {
  if (event.type !== 'assistant/message') return
  const usage = event.data?.usage
  const source = event.data?.message?.source
  if (usage === undefined || source?.kind !== 'model') return
  if (typeof source.model !== 'string') return
  foldCall(days, {
    provider: typeof source.provider === 'string' ? source.provider : null,
    model: source.model,
    usage,
    time: event.time,
  })
}

/**
 * The rolling local-token accounting for one DSH home.
 *
 * Two sources feed the same buckets, one per call:
 *
 *  - `record` is the live path. The suite already sits on `llm/stream`, so a
 *    request's own usage report is folded as it happens: no reads, no sweep,
 *    and the card is correct the moment a turn ends. It counts what the
 *    adapters report, which includes a retried attempt's partial usage —
 *    tokens the provider did bill.
 *  - `refresh` is the log path, for seeding history the live path could not
 *    see. It is slower and bounded per refresh, and it counts one completed
 *    model answer each. A deployment picks one, because a call seen by both
 *    would be counted twice.
 */
export class UsageLedger {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] - clock injection for tests.
   */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
    /** day key -> model key -> mutable row */
    this.days = new Map()
    /** session id -> { revision, offset, eventCount, failures } */
    this.sessions = new Map()
    this.updatedAt = null
    this.sweep = { sessions: 0, changed: 0, processed: 0, failed: 0, complete: true, elapsedMs: 0 }
    this.inflight = undefined
  }

  /**
   * Fold one live request's usage report.
   * @param {object} call - `{ provider, model, usage, time? }`; `time` defaults to now.
   * @returns {boolean} whether the call carried a usage report worth counting.
   */
  record({ provider, model, usage, time } = {}) {
    if (usage === undefined || typeof model !== 'string' || model.length === 0) return false
    foldCall(this.days, {
      provider: typeof provider === 'string' ? provider : null,
      model,
      usage,
      time: typeof time === 'number' ? time : this.now(),
    })
    this.updatedAt = new Date(this.now()).toISOString()
    return true
  }

  /**
   * The buckets as a plain document, for the state file the live source keeps
   * across restarts. Only the counters travel; the log sweep state does not,
   * because it is rebuilt from storage on the next refresh anyway.
   * @returns {object} the persisted document.
   */
  serialize() {
    return {
      version: 1,
      updatedAt: this.updatedAt,
      days: [...this.days.entries()].map(([day, models]) => [
        day,
        [...models.entries()].map(([model, row]) => [model, { ...row }]),
      ]),
    }
  }

  /**
   * Merge a persisted document back in. Existing buckets are added to, so
   * restoring twice cannot double anything; a malformed or foreign document is
   * ignored rather than throwing, because a corrupt state file must not keep
   * the card from loading.
   * @param {unknown} document - a value previously produced by {@link serialize}.
   * @returns {boolean} whether anything was restored.
   */
  restore(document) {
    if (document === null || typeof document !== 'object') return false
    if (document.version !== 1 || !Array.isArray(document.days)) return false
    let restored = false
    for (const [day, models] of document.days) {
      if (typeof day !== 'string' || !Array.isArray(models)) continue
      let bucket = this.days.get(day)
      if (bucket === undefined) {
        bucket = new Map()
        this.days.set(day, bucket)
      }
      for (const [model, row] of models) {
        if (typeof model !== 'string' || row === null || typeof row !== 'object') continue
        const numbers = ['calls', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']
          .map(field => (typeof row[field] === 'number' && Number.isFinite(row[field]) ? row[field] : 0))
        const [calls, input, output, cacheRead, cacheWrite, reasoning] = numbers
        if (calls === 0 && input === 0 && output === 0 && cacheRead === 0) continue
        const target = bucket.get(model) ?? emptyRow()
        addRow(target, { calls, input, output, cacheRead, cacheWrite, reasoning })
        bucket.set(model, target)
        restored = true
      }
    }
    if (restored) this.updatedAt = typeof document.updatedAt === 'string' ? document.updatedAt : this.updatedAt
    return restored
  }

  /**
   * Fold every session that changed since the last refresh, newest growth
   * first, under the configured sweep budget. Concurrent callers share one
   * sweep.
   *
   * Both budgets apply: a count of sessions and a wall clock. A store with
   * thousands of sessions, or a few very large ones, therefore answers in
   * bounded time and reports the remainder as queued instead of blocking a
   * card or a tool call.
   * @param {object} persistence - the `sessionPersistence` service.
   * @param {object} [options]
   * @param {number} [options.sessionsPerSweep] - budget for this refresh.
   * @param {number} [options.maxMs] - wall-clock budget for this refresh.
   * @param {number} [options.retentionDays] - day buckets kept after folding.
   * @param {AbortSignal} [options.signal] - optional cancellation.
   * @returns {Promise<void>} resolves when the sweep is folded in.
   */
  async refresh(persistence, {
    sessionsPerSweep = DEFAULT_SESSIONS_PER_SWEEP,
    maxMs = DEFAULT_SWEEP_MAX_MS,
    retentionDays = DEFAULT_RETENTION_DAYS,
    signal,
  } = {}) {
    if (this.inflight !== undefined) return this.inflight
    const promise = Promise.resolve()
      .then(() => this.runSweep(persistence, sessionsPerSweep, maxMs, retentionDays, signal))
      .finally(() => { this.inflight = undefined })
    this.inflight = promise
    return promise
  }

  async runSweep(persistence, sessionsPerSweep, maxMs, retentionDays, signal) {
    const listed = await persistence.list({ signal })
    const tracked = new Set()
    const candidates = []
    for (const snapshot of listed) {
      const id = snapshot.header.id
      tracked.add(id)
      const previous = this.sessions.get(id)
      const sameRevision = previous !== undefined && previous.revision === snapshot.revision
      const failures = previous?.failures ?? 0
      // A clean pass on an unmoved log is nothing to do; a failed pass on an
      // unmoved log is worth retrying, because the failure can be transient (a
      // log still being written) — until FAILURE_LIMIT of them say otherwise.
      // A log that then moves its revision earns a fresh budget, so a repaired
      // session comes back on its own.
      if (sameRevision && (failures === 0 || failures >= FAILURE_LIMIT)) continue
      const growth = (typeof snapshot.eventCount === 'number' ? snapshot.eventCount : 0)
        - (previous?.eventCount ?? 0)
      candidates.push({ snapshot, previous, growth })
    }
    for (const id of [...this.sessions.keys()]) {
      if (!tracked.has(id)) this.sessions.delete(id)
    }
    candidates.sort((a, b) => b.growth - a.growth
      || (b.snapshot.sizeBytes ?? 0) - (a.snapshot.sizeBytes ?? 0)
      || String(a.snapshot.header.id).localeCompare(String(b.snapshot.header.id)))

    const budget = Number.isSafeInteger(sessionsPerSweep) && sessionsPerSweep > 0 ? sessionsPerSweep : DEFAULT_SESSIONS_PER_SWEEP
    const deadline = Number.isFinite(maxMs) && maxMs > 0 ? this.now() + maxMs : undefined
    const startedAt = this.now()
    let processed = 0
    let failed = 0
    // The clock is checked BETWEEN sessions, never mid-read: a single log is
    // atomic work, and abandoning it half-folded would double-count on the next
    // pass.
    for (const candidate of candidates) {
      if (processed >= budget) break
      if (deadline !== undefined && processed > 0 && this.now() >= deadline) break
      signal?.throwIfAborted()
      if (await this.foldSession(persistence, candidate, signal)) failed += 1
      processed += 1
    }
    this.trim(retentionDays)
    this.sweep = {
      sessions: listed.length,
      changed: candidates.length,
      processed,
      failed,
      complete: candidates.length <= processed,
      elapsedMs: this.now() - startedAt,
    }
    this.updatedAt = new Date(this.now()).toISOString()
  }

  /**
   * Read one session's new events and fold them. A failure leaves the session
   * untracked-at-its-old-offset so the next sweep retries it, and never
   * propagates: one unreadable log must not blank the whole dashboard.
   * @returns {boolean} true when the session failed to fold.
   */
  async foldSession(persistence, { snapshot, previous }, signal) {
    const id = snapshot.header.id
    let handle
    try {
      handle = await persistence.open(id, 'read', { signal })
      let offset = previous?.offset ?? 0
      for (;;) {
        signal?.throwIfAborted()
        const page = await handle.read(offset, READ_PAGE, { signal })
        if (page.events.length === 0) break
        for (const event of page.events) foldEvent(this.days, event)
        offset = page.events[page.events.length - 1].seq + 1
        if (page.events.length < READ_PAGE) break
      }
      this.sessions.set(id, {
        revision: snapshot.revision,
        offset,
        eventCount: typeof snapshot.eventCount === 'number' ? snapshot.eventCount : offset,
        failures: 0,
      })
      return false
    } catch (error) {
      if (signal?.aborted) throw error
      // The offset is not advanced, so a later attempt re-reads the same range
      // rather than skipping calls the failed pass never folded.
      this.sessions.set(id, {
        revision: snapshot.revision,
        offset: previous?.offset ?? 0,
        eventCount: previous?.eventCount ?? 0,
        failures: (previous?.failures ?? 0) + 1,
      })
      return true
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch {
          // A handle that cannot close is the backend's problem, not the fold's.
        }
      }
    }
  }

  /** Drop day buckets past the retention horizon. */
  trim(retentionDays) {
    const days = Number.isSafeInteger(retentionDays) && retentionDays > 0 ? retentionDays : DEFAULT_RETENTION_DAYS
    const horizon = dayKeyOf(this.now() - (days - 1) * 24 * 60 * 60 * 1000)
    for (const day of [...this.days.keys()]) {
      if (day < horizon) this.days.delete(day)
    }
  }

  /**
   * The folded accounting as the card and the tool read it.
   * @param {object} [options]
   * @param {number} [options.windowDays] - days reported, newest last.
   * @param {number} [options.retentionDays] - horizon reported to the caller.
   * @returns {object} the wire payload.
   */
  snapshot({ windowDays = DEFAULT_WINDOW_DAYS, retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
    const days = Number.isSafeInteger(windowDays) && windowDays > 0 ? windowDays : DEFAULT_WINDOW_DAYS
    const retention = Number.isSafeInteger(retentionDays) && retentionDays > 0 ? retentionDays : DEFAULT_RETENTION_DAYS
    const floor = dayKeyOf(this.now() - (days - 1) * 24 * 60 * 60 * 1000)
    const window = [...this.days.entries()].filter(([day]) => day >= floor).sort((a, b) => a[0].localeCompare(b[0]))
    const models = new Map()
    const totals = emptyRow()
    let reportedDays = 0
    const dayRows = window.map(([date, byModel]) => {
      reportedDays += 1
      const dayTotals = emptyRow()
      const rows = [...byModel.entries()].map(([model, row]) => {
        addRow(dayTotals, row)
        let modelTotals = models.get(model)
        if (modelTotals === undefined) {
          modelTotals = emptyRow()
          models.set(model, modelTotals)
        }
        addRow(modelTotals, row)
        return { model, ...publish(row) }
      })
      addRow(totals, dayTotals)
      rows.sort((a, b) => b.total - a.total)
      return { date, ...publish(dayTotals), models: rows }
    })
    const modelRows = [...models.entries()]
      .map(([model, row]) => ({ model, ...publish(row) }))
      .sort((a, b) => b.total - a.total)
    const windowTotal = publish(totals)
    for (const row of modelRows) {
      row.share = windowTotal.total === 0 ? 0 : row.total / windowTotal.total
    }
    for (const day of dayRows) {
      for (const row of day.models) {
        row.share = day.total === 0 ? 0 : row.total / day.total
      }
    }
    return {
      updatedAt: this.updatedAt,
      windowDays: days,
      retentionDays: retention,
      sweep: { ...this.sweep },
      days: dayRows,
      models: modelRows,
      totals: { ...windowTotal, days: reportedDays },
    }
  }
}
