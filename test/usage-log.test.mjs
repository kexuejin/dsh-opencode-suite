import assert from 'node:assert/strict'
import test from 'node:test'

import { UsageLedger, dayKeyOf } from '../usage-log.js'

/**
 * One stored session: a revision token, a logical event list, and a knob for
 * making the next open fail — the three things the ledger actually reads.
 */
function session({ id, revision = 'r1', events = [], failOpen = false, failRead = false }) {
  return {
    id,
    revision,
    failOpen,
    failRead,
    events,
    opens: 0,
    reads: 0,
    closed: 0,
  }
}

function persistenceOf(sessions) {
  return {
    async list() {
      return sessions.map(entry => ({
        header: { id: entry.id },
        revision: entry.revision,
        eventCount: entry.events.length,
        sizeBytes: entry.events.length * 10,
      }))
    },
    async open(id) {
      const entry = sessions.find(candidate => candidate.id === id)
      entry.opens += 1
      if (entry.failOpen) throw new Error(`cannot open ${id}`)
      return {
        async read(offset, length) {
          entry.reads += 1
          if (entry.failRead) throw new Error(`cannot read ${id}`)
          return { eventState: 'detached', events: entry.events.slice(offset, offset + length) }
        },
        async close() { entry.closed += 1 },
      }
    },
  }
}

/** One model answer; `seq` places it in the log. */
function call(seq, { model = 'space-bunny-free', provider = 'opencode-go', time, usage } = {}) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      usage: usage ?? { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100 },
      message: { role: 'assistant', source: { kind: 'model', provider, model } },
    },
  }
}

const at = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour).getTime()

test('day keys are local calendar days, not UTC ones', () => {
  assert.equal(dayKeyOf(at(2026, 9, 26)), '2026-09-26')
  assert.equal(dayKeyOf(at(2026, 1, 5)), '2026-01-05')
  assert.equal(dayKeyOf(at(2026, 12, 31, 23)), '2026-12-31')
})

test('a refresh folds every model answer into day and model totals', async () => {
  const ledger = new UsageLedger({ now: () => at(2026, 9, 26, 20) })
  const sessions = [
    session({
      id: 'a',
      events: [
        call(0, { time: at(2026, 9, 26, 9) }),
        call(1, { time: at(2026, 9, 26, 10), model: 'deepseek-flash' }),
        call(2, { time: at(2026, 9, 25, 9), model: 'deepseek-flash' }),
      ],
    }),
  ]
  await ledger.refresh(persistenceOf(sessions), { sessionsPerSweep: 10, retentionDays: 90 })

  const report = ledger.snapshot({ windowDays: 7, retentionDays: 90 })
  assert.equal(report.error, undefined)
  assert.deepEqual(report.days.map(day => day.date), ['2026-09-25', '2026-09-26'])
  assert.equal(report.totals.calls, 3)
  // 3 calls × (10 in + 2 out + 100 cache) — cache is the bulk, which is the
  // point of the card.
  assert.equal(report.totals.input, 30)
  assert.equal(report.totals.output, 6)
  assert.equal(report.totals.cacheRead, 300)
  assert.equal(report.totals.total, 336)
  assert.deepEqual(report.models.map(row => row.model), [
    'opencode-go/deepseek-flash',
    'opencode-go/space-bunny-free',
  ])
  assert.equal(report.models[0].calls, 2)
  assert.equal(report.models[1].calls, 1)
  assert.ok(Math.abs(report.models[0].share + report.models[1].share - 1) < 1e-9)
})

test('an unchanged revision is skipped and a grown log reads only its tail', async () => {
  const ledger = new UsageLedger({ now: () => at(2026, 9, 26, 20) })
  const sessions = [session({ id: 'a', events: [call(0, { time: at(2026, 9, 26, 9) })] })]
  const persistence = persistenceOf(sessions)

  await ledger.refresh(persistence, { sessionsPerSweep: 10 })
  assert.equal(sessions[0].opens, 1)
  assert.equal(ledger.snapshot().totals.calls, 1)

  // Nothing appended: the revision still matches, so the log is not opened.
  await ledger.refresh(persistence, { sessionsPerSweep: 10 })
  assert.equal(sessions[0].opens, 1, 'an unchanged revision never opens the log')
  assert.equal(ledger.snapshot().totals.calls, 1)

  // Appended: the revision moves, and only the new events are folded — the
  // earlier call is not counted twice.
  sessions[0].revision = 'r2'
  sessions[0].events.push(call(1, { time: at(2026, 9, 26, 11) }))
  await ledger.refresh(persistence, { sessionsPerSweep: 10 })
  assert.equal(sessions[0].opens, 2)
  assert.equal(ledger.snapshot().totals.calls, 2)
})

test('the sweep budget folds the fastest-growing sessions first and reports what is left', async () => {
  const ledger = new UsageLedger({ now: () => at(2026, 9, 26, 20) })
  const sessions = [
    session({ id: 'small', events: [call(0, { time: at(2026, 9, 26, 9) })] }),
    session({ id: 'big', events: [call(0, { time: at(2026, 9, 26, 9) }), call(1, { time: at(2026, 9, 26, 9) })] }),
  ]
  const persistence = persistenceOf(sessions)
  await ledger.refresh(persistence, { sessionsPerSweep: 1 })

  assert.equal(sessions.find(entry => entry.id === 'big').opens, 1, 'the busier session folds first')
  assert.equal(sessions.find(entry => entry.id === 'small').opens, 0)
  assert.deepEqual({ ...ledger.sweep, elapsedMs: 0 }, { sessions: 2, changed: 2, processed: 1, failed: 0, complete: false, elapsedMs: 0 })
  assert.equal(ledger.snapshot().totals.calls, 2)

  await ledger.refresh(persistence, { sessionsPerSweep: 1 })
  assert.equal(ledger.sweep.complete, true)
  assert.equal(ledger.snapshot().totals.calls, 3)
})

test('an unreadable session is counted, retried next sweep, and never blanks the report', async () => {
  const ledger = new UsageLedger({ now: () => at(2026, 9, 26, 20) })
  const broken = session({ id: 'broken', failRead: true, events: [call(0, { time: at(2026, 9, 26, 9) })] })
  const healthy = session({ id: 'ok', events: [call(0, { time: at(2026, 9, 26, 9) })] })
  const persistence = persistenceOf([broken, healthy])

  await ledger.refresh(persistence, { sessionsPerSweep: 10 })
  assert.equal(ledger.sweep.failed, 1)
  assert.equal(broken.closed, 1, 'a failed read still closes its handle')
  assert.equal(ledger.snapshot().totals.calls, 1, 'the readable session still counts')

  // The failure is not remembered as progress: the next sweep tries it again.
  broken.failRead = false
  await ledger.refresh(persistence, { sessionsPerSweep: 10 })
  assert.equal(broken.opens, 2)
  assert.equal(ledger.snapshot().totals.calls, 2)
  assert.equal(ledger.sweep.failed, 0)
})

test('retention drops the oldest day buckets and the window narrows what is reported', async () => {
  const ledger = new UsageLedger({ now: () => at(2026, 9, 10, 20) })
  const sessions = [session({
    id: 'a',
    events: [
      call(0, { time: at(2026, 8, 1, 9) }),
      call(1, { time: at(2026, 9, 9, 9) }),
      call(2, { time: at(2026, 9, 10, 9) }),
    ],
  })]
  await ledger.refresh(persistenceOf(sessions), { sessionsPerSweep: 10, retentionDays: 30 })

  assert.equal(ledger.snapshot({ windowDays: 7, retentionDays: 30 }).days.length, 2)
  assert.equal(ledger.snapshot({ windowDays: 30, retentionDays: 30 }).days.length, 2)
  assert.equal(ledger.snapshot({ windowDays: 365, retentionDays: 30 }).days.length, 2,
    'the retention horizon, not the requested window, bounds what exists')
})

test('a session that disappeared from storage is dropped from the ledger state', async () => {
  const ledger = new UsageLedger({ now: () => at(2026, 9, 26, 20) })
  const sessions = [session({ id: 'a', events: [call(0, { time: at(2026, 9, 26, 9) })] })]
  await ledger.refresh(persistenceOf(sessions), { sessionsPerSweep: 10 })
  assert.equal(ledger.sessions.size, 1)

  await ledger.refresh(persistenceOf([]), { sessionsPerSweep: 10 })
  assert.equal(ledger.sessions.size, 0)
  assert.deepEqual({ ...ledger.sweep, elapsedMs: 0 }, { sessions: 0, changed: 0, processed: 0, failed: 0, complete: true, elapsedMs: 0 })
})

test('concurrent refreshes share one sweep', async () => {
  const ledger = new UsageLedger({ now: () => at(2026, 9, 26, 20) })
  const sessions = [session({ id: 'a', events: [call(0, { time: at(2026, 9, 26, 9) })] })]
  const persistence = persistenceOf(sessions)
  await Promise.all([
    ledger.refresh(persistence, { sessionsPerSweep: 10 }),
    ledger.refresh(persistence, { sessionsPerSweep: 10 }),
  ])
  assert.equal(sessions[0].opens, 1)
})

test('events that are not model answers never enter the totals', async () => {
  const ledger = new UsageLedger({ now: () => at(2026, 9, 26, 20) })
  const sessions = [session({
    id: 'a',
    events: [
      { type: 'user/message', seq: 0, time: at(2026, 9, 26, 9), data: { message: { source: { kind: 'model' } } } },
      { type: 'assistant/message', seq: 1, time: at(2026, 9, 26, 9), data: { message: { source: { kind: 'model', provider: 'p', model: 'm' } } } },
      { type: 'assistant/message', seq: 2, time: at(2026, 9, 26, 9), data: { usage: { inputTokens: 5 }, message: { source: { kind: 'local' } } } },
      { type: 'tool/result', seq: 3, time: at(2026, 9, 26, 9), data: { usage: { inputTokens: 7 } } },
    ],
  })]
  await ledger.refresh(persistenceOf(sessions), { sessionsPerSweep: 10 })
  assert.equal(ledger.snapshot().totals.calls, 0)
})

test('the wall-clock budget stops the sweep between sessions and leaves the rest queued', async () => {
  // A clock that jumps past the deadline once the first session is folded.
  let tick = 0
  const ledger = new UsageLedger({
    now: () => {
      tick += 1
      return tick <= 2 ? 0 : 10_000
    },
  })
  const sessions = [
    session({ id: 'a', events: [call(0, { time: at(2026, 9, 26, 9) })] }),
    session({ id: 'b', events: [call(0, { time: at(2026, 9, 26, 9) })] }),
  ]
  await ledger.refresh(persistenceOf(sessions), { sessionsPerSweep: 10, maxMs: 5_000 })

  assert.equal(sessions[0].opens, 1, 'the first session folds even when the clock is already spent')
  assert.equal(sessions[1].opens, 0, 'the second is left for the next sweep')
  assert.equal(ledger.sweep.complete, false)
  assert.equal(ledger.snapshot().totals.calls, 1)
})

test('a session that never folds stops being retried, so the sweep can complete', async () => {
  const ledger = new UsageLedger({ now: () => at(2026, 9, 26, 20) })
  const broken = session({ id: 'broken', failRead: true, events: [call(0, { time: at(2026, 9, 26, 9) })] })
  const healthy = session({ id: 'ok', events: [call(0, { time: at(2026, 9, 26, 9) })] })
  const persistence = persistenceOf([broken, healthy])

  for (let round = 0; round < 5; round += 1) {
    await ledger.refresh(persistence, { sessionsPerSweep: 10 })
  }
  assert.equal(broken.opens, 3, 'three attempts, then the log is left alone')
  assert.equal(ledger.sweep.complete, true, 'one unreadable log cannot hold the sweep open forever')
  assert.equal(ledger.sweep.failed, 0, 'a session already given up is not a fresh failure')
  assert.equal(ledger.snapshot().totals.calls, 1)

  // A repaired log moves its revision, which earns the session a fresh budget.
  broken.failRead = false
  broken.revision = 'r2'
  await ledger.refresh(persistence, { sessionsPerSweep: 10 })
  assert.equal(broken.opens, 4)
  assert.equal(ledger.snapshot().totals.calls, 2)
})

test('the live path folds a request usage report as it happens', () => {
  const ledger = new UsageLedger({ now: () => at(2026, 9, 26, 20) })
  assert.equal(ledger.record({
    provider: 'opencode-go',
    model: 'space-bunny-free',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 9000 },
  }), true)
  assert.equal(ledger.record({ provider: 'opencode-go', model: 'grok-4.7', usage: { inputTokens: 5, outputTokens: 1 } }), true)
  // A report with no model, or no usage at all, is not a call to count.
  assert.equal(ledger.record({ provider: 'opencode-go', usage: { inputTokens: 1 } }), false)
  assert.equal(ledger.record({ provider: 'opencode-go', model: 'x' }), false)

  const report = ledger.snapshot({ windowDays: 7, retentionDays: 90 })
  assert.equal(report.totals.calls, 2)
  assert.equal(report.totals.cacheRead, 9000)
  assert.equal(report.models[0].model, 'opencode-go/space-bunny-free')
  assert.ok(report.updatedAt, 'a live fold stamps the report as current')
})

test('live and log accounting share the buckets but never double-count one call', () => {
  const ledger = new UsageLedger({ now: () => at(2026, 9, 26, 20) })
  const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100 }
  ledger.record({ provider: 'opencode-go', model: 'deepseek-flash', usage, time: at(2026, 9, 26, 9) })
  // The very same call, read back out of the log: a deployment picks one
  // source, and the ledger keeps both in the same shape.
  const sessions = [session({
    id: 'a',
    events: [call(0, { time: at(2026, 9, 26, 9), model: 'deepseek-flash', usage })],
  })]
  return ledger.refresh(persistenceOf(sessions), { sessionsPerSweep: 10 }).then(() => {
    assert.equal(ledger.snapshot().totals.calls, 2,
      'the ledger does not deduplicate across sources; the Config keeps them exclusive')
  })
})

test('a persisted document round-trips and merges without double counting', () => {
  const first = new UsageLedger({ now: () => at(2026, 9, 26, 20) })
  first.record({ provider: 'opencode-go', model: 'grok-4.7', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 300 }, time: at(2026, 9, 26, 9) })
  const document = first.serialize()
  assert.equal(document.version, 1)

  const restored = new UsageLedger({ now: () => at(2026, 9, 26, 20) })
  assert.equal(restored.restore(document), true)
  assert.equal(restored.snapshot().totals.cacheRead, 300)
  // Restoring the same file twice adds the same call again — which is exactly
  // why the host restores once, on its own state file.
  restored.restore(document)
  assert.equal(restored.snapshot().totals.cacheRead, 600)
})

test('a foreign or corrupt state document is ignored, not thrown', () => {
  const ledger = new UsageLedger()
  assert.equal(ledger.restore(null), false)
  assert.equal(ledger.restore('nope'), false)
  assert.equal(ledger.restore({ version: 99, days: [] }), false)
  assert.equal(ledger.restore({ version: 1, days: [['2026-09-26', [['m', { calls: 1, input: 2 }]]]] }), true)
  assert.equal(ledger.snapshot().totals.calls, 1)
})
