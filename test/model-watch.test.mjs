import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ModelWatcher } from '../model-watch.js'

const at = (day, hour = 12) => new Date(2026, 8, day, hour).getTime()

/** A listing reader a test can swap between passes. */
function listings(pairs) {
  return async (tierId) => {
    const ids = pairs[tierId]
    if (ids instanceof Error) throw ids
    if (ids === undefined) throw new Error(`${tierId} unreachable`)
    return ids
  }
}

test('the first pass is a baseline, not an announcement of the whole catalog', async () => {
  const watcher = new ModelWatcher({ now: () => at(26) })
  const result = await watcher.check(listings({ go: ['a', 'b'], free: ['f1'] }))
  assert.deepEqual(result.notices, [], 'a fresh state adopts what is already online')
  assert.equal(watcher.pendingCount(), 0)
  assert.equal(watcher.report().tiers.go.online, 2)
})

test('a model that appears later is announced once, with the time it was first seen', async () => {
  let clock = at(26)
  const watcher = new ModelWatcher({ now: () => clock })
  await watcher.check(listings({ go: ['a', 'b'], free: ['f1'] }))

  clock = at(27, 9)
  const first = await watcher.check(listings({ go: ['a', 'b', 'c'], free: ['f1'] }))
  assert.deepEqual(first.notices, ['go:c'])

  // A later pass says nothing more about it.
  clock = at(28)
  const second = await watcher.check(listings({ go: ['a', 'b', 'c'], free: ['f1'] }))
  assert.deepEqual(second.notices, [])
  assert.deepEqual(watcher.pending('go'), [{ id: 'c', firstSeenAt: new Date(at(27, 9)).toISOString() }])
})

test('a model that leaves and comes back is announced again', async () => {
  const watcher = new ModelWatcher({ now: () => at(26) })
  await watcher.check(listings({ go: ['a', 'b'], free: [] }))
  await watcher.check(listings({ go: ['a'], free: [] }))
  assert.deepEqual(watcher.gone('go').map(row => row.id), ['b'])

  const back = await watcher.check(listings({ go: ['a', 'b'], free: [] }))
  assert.deepEqual(back.notices, ['go:b'], 'a returning id is news again')
  assert.deepEqual(watcher.gone('go'), [], 'and it is no longer reported as gone')
})

test('a failing tier records the error and never blocks the other one', async () => {
  const watcher = new ModelWatcher({ now: () => at(26) })
  const result = await watcher.check(listings({ go: new Error('502 from the gateway'), free: ['f1'] }))
  assert.match(watcher.report().error, /502/)
  assert.equal(watcher.report().tiers.free.online, 1)

  const recovered = await watcher.check(listings({ go: ['a'], free: ['f1'] }))
  assert.equal(watcher.report().error, null)
  assert.deepEqual(recovered.notices, [], 'the recovered tier is a baseline, not news')
})

test('acknowledging clears the news but not the seen set', async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'dsh-watch-')), 'watched.json')
  const watcher = new ModelWatcher({ statePath, now: () => at(26) })
  await watcher.check(listings({ go: ['a'], free: [] }))
  await watcher.check(listings({ go: ['a', 'b'], free: [] }))
  assert.equal(watcher.pendingCount(), 1)

  assert.equal(watcher.acknowledge('go'), 1)
  assert.equal(watcher.pendingCount(), 0)

  // The dismissed id is not announced again on the next pass.
  const again = await watcher.check(listings({ go: ['a', 'b'], free: [] }))
  assert.deepEqual(again.notices, [])
  assert.equal(readFileSync(statePath, 'utf8').includes('"b"'), true, 'the seen set survives on disk')
})

test('a new process restores its news from the state file', async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'dsh-watch-')), 'watched.json')
  const first = new ModelWatcher({ statePath, now: () => at(26) })
  await first.check(listings({ go: ['a'], free: [] }))
  await first.check(listings({ go: ['a', 'b', 'c'], free: [] }))
  assert.equal(first.pendingCount(), 2)

  const restored = new ModelWatcher({ statePath, now: () => at(29) })
  assert.equal(restored.pendingCount(), 2, 'a restart does not forget what is new')
  const checked = await restored.check(listings({ go: ['a', 'b', 'c'], free: [] }))
  assert.deepEqual(checked.notices, [], 'and it does not re-announce it')
})

test('a corrupt state file starts the count over instead of throwing', async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'dsh-watch-')), 'watched.json')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(statePath, '{ this is not json')
  const watcher = new ModelWatcher({ statePath, now: () => at(26) })
  assert.equal(watcher.pendingCount(), 0)
  const result = await watcher.check(listings({ go: ['a'], free: [] }))
  assert.deepEqual(result.notices, [], 'the restarted baseline is not news')
})

test('concurrent passes share one sweep', async () => {
  let opens = 0
  const watcher = new ModelWatcher({ now: () => at(26) })
  const read = async tierId => {
    if (tierId === 'go') opens += 1
    return tierId === 'go' ? ['a'] : []
  }
  await Promise.all([watcher.check(read), watcher.check(read)])
  assert.equal(opens, 1)
})

test('a baseline pass is persisted, so the reference the next pass diffs against exists', async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'dsh-watch-')), 'watched.json')
  const watcher = new ModelWatcher({ statePath, now: () => at(26) })
  await watcher.check(listings({ go: ['a', 'b'], free: ['f1'] }))

  // Saving only on news left a clean deployment with NO file, so neither the
  // baseline nor the time of the check could be read back.
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.deepEqual(saved.go.seen, ['a', 'b'], 'the baseline the next pass diffs against is on disk')
  assert.equal(saved.go.seeded, true)
  assert.ok(readFileSync(statePath, 'utf8').length > 0)
  assert.equal(watcher.report().seeded, true, 'both tiers are seeded after one pass')
  assert.deepEqual(watcher.report().tiers.go.onlineIds, ['a', 'b'],
    'the report carries the online ids so a caller can intersect them with what it exposes')
})

test('an idle pass rewrites the file, so the last check time is never stale', async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'dsh-watch-')), 'watched.json')
  const watcher = new ModelWatcher({ statePath, now: () => at(26) })
  await watcher.check(listings({ go: ['a'], free: [] }))
  const first = watcher.lastCheckedAt
  await watcher.check(listings({ go: ['a'], free: [] }))
  assert.equal(watcher.lastCheckedAt, first, 'same clock, same stamp')
  assert.equal(watcher.pendingCount(), 0)
  assert.ok(readFileSync(statePath, 'utf8').includes('"seen"'), 'the state still names what it saw')
})
