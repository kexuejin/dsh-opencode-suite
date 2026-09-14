import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KeyPool, assertKeyEntry, assertKeyList, authFaultKind, AUTH_CODE, QUOTA_CODE, INVALID_CREDENTIAL_CODE } from '../pool.js'

/**
 * The gateway's own words, captured live from `zen/go/v1`. It answers all three
 * on 401/403 — the very statuses a dead key produces — so nothing but the
 * payload can tell them apart:
 *   AuthError   401  invalid / missing API key      → the key really is bad
 *   ModelError  401  model it will not serve        → the key is innocent
 *   RegionError 403  model blocked in this country  → the key is innocent
 */
const GATEWAY_AUTH_ERROR = 'OpenAI API error (401): {"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}'
const GATEWAY_MODEL_ERROR = 'OpenAI API error (401): {"type":"error","error":{"type":"ModelError","message":"Model grok-4.6 is not supported for format oa-compat"}}'
const GATEWAY_REGION_ERROR = 'OpenAI API error (403): {"type":"RegionError","message":"This model is not available in your country."}'

const KEYS = [
  { id: 'acc-a', label: '主号', apiKeyEnv: 'OPENCODE_GO_KEY_A' },
  { id: 'acc-b', label: '备用2', apiKeyEnv: 'OPENCODE_GO_KEY_B' },
  { id: 'acc-c', label: '备用3', apiKeyEnv: 'OPENCODE_GO_KEY_C' },
]

function freshPool(stateFile = null) {
  return new KeyPool({ stateFile })
}

test('assertKeyEntry rejects malformed entries', () => {
  assert.throws(() => assertKeyEntry({}), /must be an object|key id/)
  assert.throws(() => assertKeyEntry({ id: 'BAD ID', label: 'x', apiKeyEnv: 'K' }), /must match/)
  assert.throws(() => assertKeyEntry({ id: 'ok', label: '  ', apiKeyEnv: 'K' }), /label/)
  assert.throws(() => assertKeyEntry({ id: 'ok', label: 'x', apiKeyEnv: '1bad' }), /credential reference/)
  assertKeyEntry({ id: 'acc-a', label: '主号', apiKeyEnv: 'OPENCODE_GO_KEY_A' })
})

test('assertKeyList rejects duplicate ids and duplicate env refs', () => {
  assert.throws(() => assertKeyList([KEYS[0], KEYS[0]]), /duplicate key id/)
  assert.throws(() => assertKeyList([KEYS[0], { ...KEYS[1], id: 'acc-x', apiKeyEnv: KEYS[0].apiKeyEnv }]), /duplicate apiKeyEnv/)
  assertKeyList(KEYS)
})

test('first key becomes active; selection is sticky', () => {
  const pool = freshPool()
  pool.syncKeys(KEYS)
  assert.equal(pool.currentKey().id, 'acc-a')
  pool.setActive('acc-b')
  assert.equal(pool.currentKey().id, 'acc-b')
})

test('quota failure marks the key exhausted and rotates to the next', () => {
  const pool = freshPool()
  pool.syncKeys(KEYS)
  const rotation = pool.onFailure('acc-a', { code: QUOTA_CODE, message: 'quota' })
  assert.deepEqual(rotation, { from: 'acc-a', to: 'acc-b' })
  assert.equal(pool.stateOf('acc-a').state, 'exhausted')
  assert.equal(pool.currentKey().id, 'acc-b')
  assert.equal(pool.lastSwitch.reason, 'quota')
})

test('credential failure marks invalid and rotates; invalid keys never revive on usage', () => {
  const pool = freshPool()
  pool.syncKeys(KEYS)
  pool.onFailure('acc-a', { code: INVALID_CREDENTIAL_CODE, message: 'bad' })
  assert.equal(pool.stateOf('acc-a').state, 'invalid')
  assert.equal(pool.currentKey().id, 'acc-b')
  pool.onUsage('acc-a', { rolling: { status: 'ok', percent: 0 }, weekly: null, monthly: null })
  assert.equal(pool.stateOf('acc-a').state, 'invalid')
})

test('transient codes do not rotate', () => {
  const pool = freshPool()
  pool.syncKeys(KEYS)
  const rotation = pool.onFailure('acc-a', { code: 'RATE_LIMIT', message: 'slow down' })
  assert.equal(rotation, null)
  assert.equal(pool.stateOf('acc-a').state, 'healthy')
  assert.equal(pool.currentKey().id, 'acc-a')
})

test('when every key is exhausted the pool is dry', () => {
  const pool = freshPool()
  pool.syncKeys(KEYS)
  for (const key of ['acc-a', 'acc-b', 'acc-c']) pool.onFailure(key, { code: QUOTA_CODE })
  assert.equal(pool.currentKey(), null)
  assert.equal(pool.usableCount(), 0)
})

test('exhausted keys revive once rolling usage reports ok below threshold', () => {
  const pool = freshPool()
  pool.syncKeys(KEYS)
  pool.onFailure('acc-a', { code: QUOTA_CODE })
  assert.equal(pool.currentKey().id, 'acc-b')
  pool.onUsage('acc-a', { rolling: { status: 'ok', percent: 3 }, weekly: null, monthly: null })
  assert.equal(pool.stateOf('acc-a').state, 'healthy')
  pool.setActive('acc-a')
  assert.equal(pool.currentKey().id, 'acc-a')
})

test('preempt also skips keys whose WEEKLY window reached the threshold', () => {
  const pool = freshPool()
  pool.setPreempt(90)
  pool.syncKeys(KEYS)
  // Rolling low, but weekly full: the key is preempted anyway.
  pool.onUsage('acc-a', {
    rolling: { status: 'ok', percent: 44 },
    weekly: { status: 'rate-limited', percent: 100 },
    monthly: { status: 'ok', percent: 51 },
  })
  assert.equal(pool.currentKey().id, 'acc-b')
  // With preemption off (100) the same key is usable again.
  pool.setPreempt(100)
  assert.equal(pool.isUsable('acc-a'), true)
})

test('preemptAtPercent skips healthy keys near exhaustion', () => {
  const pool = freshPool()
  pool.setPreempt(98)
  pool.syncKeys(KEYS)
  pool.onUsage('acc-a', { rolling: { status: 'ok', percent: 99 }, weekly: null, monthly: null })
  assert.equal(pool.currentKey().id, 'acc-b')
  // Relaxing the threshold makes the key eligible again, but the sticky
  // active selection stays put — no flapping; manual switch can take it back.
  pool.setPreempt(100)
  assert.equal(pool.usableCount(), 3)
  assert.equal(pool.currentKey().id, 'acc-b')
  pool.setActive('acc-a')
  assert.equal(pool.currentKey().id, 'acc-a')
})

test('disable removes a key from selection; enable restores it', () => {
  const pool = freshPool()
  pool.syncKeys(KEYS)
  pool.setDisabled('acc-a', true)
  assert.equal(pool.currentKey().id, 'acc-b')
  pool.setDisabled('acc-a', false)
  assert.equal(pool.stateOf('acc-a').state, 'healthy')
  pool.setActive('acc-a')
  assert.equal(pool.currentKey().id, 'acc-a')
})

test('syncKeys keeps surviving state and drops removed ids', () => {
  const pool = freshPool()
  pool.syncKeys(KEYS)
  pool.onFailure('acc-a', { code: QUOTA_CODE })
  pool.syncKeys([KEYS[0], KEYS[1]])
  assert.equal(pool.stateOf('acc-a').state, 'exhausted')
  assert.equal(pool.stateOf('acc-c').state, 'healthy') // default for unknown id
  assert.equal(pool.keys.length, 2)
})

test('state file round-trips across a fresh pool instance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-suite-'))
  const stateFile = join(dir, 'pool.state.json')
  const a = new KeyPool({ stateFile })
  a.syncKeys(KEYS)
  a.onFailure('acc-a', { code: QUOTA_CODE })
  a.setDisabled('acc-c', true)
  a.setActive('acc-b')

  const b = new KeyPool({ stateFile })
  b.syncKeys(KEYS)
  assert.equal(b.stateOf('acc-a').state, 'exhausted')
  assert.equal(b.stateOf('acc-c').state, 'disabled')
  assert.equal(b.activeId, 'acc-b')
  assert.equal(b.lastSwitch.reason, 'quota')
  assert.ok(readFileSync(stateFile, 'utf8').includes('"version": 1'))
})

test('consecutive transient failures rotate away once the threshold trips', () => {
  const pool = freshPool()
  pool.setConsecutiveThreshold(2)
  pool.syncKeys(KEYS)
  // First transient failure: no rotation.
  assert.equal(pool.onFailure('acc-a', { code: 'RATE_LIMIT', message: 'slow' }), null)
  assert.equal(pool.currentKey().id, 'acc-a')
  assert.equal(pool.stateOf('acc-a').state, 'healthy')
  // Second consecutive failure: rotate, key stays healthy.
  const rotation = pool.onFailure('acc-a', { code: 'RATE_LIMIT', message: 'slow' })
  assert.deepEqual(rotation, { from: 'acc-a', to: 'acc-b' })
  assert.equal(pool.stateOf('acc-a').state, 'healthy')
  assert.equal(pool.pool ?? undefined, undefined)
  assert.equal(pool.lastSwitch.reason, 'consecutive')
  assert.equal(pool.currentKey().id, 'acc-b')
})

test('a success resets the transient-failure streak', () => {
  const pool = freshPool()
  pool.setConsecutiveThreshold(2)
  pool.syncKeys(KEYS)
  pool.onFailure('acc-a', { code: 'RATE_LIMIT', message: 'slow' })
  pool.onSuccess('acc-a')
  // Streak cleared: the next single failure must not rotate.
  assert.equal(pool.onFailure('acc-a', { code: 'RATE_LIMIT', message: 'slow' }), null)
  assert.equal(pool.currentKey().id, 'acc-a')
})

test('a single usable key never rotates to itself on consecutive failures', () => {
  const pool = freshPool()
  pool.setConsecutiveThreshold(1)
  pool.syncKeys([KEYS[0]])
  assert.equal(pool.onFailure('acc-a', { code: 'TIMEOUT', message: 'late' }), null)
  assert.equal(pool.currentKey().id, 'acc-a')
})

test('corrupt state file starts fresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-suite-'))
  const stateFile = join(dir, 'pool.state.json')
  writeFileSync(stateFile, '{not json')
  const pool = new KeyPool({ stateFile })
  pool.syncKeys(KEYS)
  assert.equal(pool.currentKey().id, 'acc-a')
})

test('clearExhausted revives a key on demand; clearInvalid only un-marks invalid', () => {
  const pool = freshPool()
  pool.syncKeys(KEYS)
  pool.onFailure('acc-a', { code: QUOTA_CODE })
  assert.equal(pool.stateOf('acc-a').state, 'exhausted')
  // clearInvalid is a no-op on an exhausted key — the two marks mean different
  // things and only the matching clearer may drop one.
  pool.clearInvalid('acc-a')
  assert.equal(pool.stateOf('acc-a').state, 'exhausted')
  pool.clearExhausted('acc-a')
  assert.equal(pool.stateOf('acc-a').state, 'healthy')
  pool.setActive('acc-a')
  assert.equal(pool.currentKey().id, 'acc-a')
})

test('clearExhausted is a no-op on a healthy key and rejects an unknown id', () => {
  const pool = freshPool()
  pool.syncKeys(KEYS)
  pool.clearExhausted('acc-a')
  assert.equal(pool.stateOf('acc-a').state, 'healthy')
  assert.throws(() => pool.clearExhausted('nope'), /unknown key/)
})

/* ------------------------------------------------------------------ *
 * Failure classification (AUTH is three different things)
 * ------------------------------------------------------------------ */

test('authFaultKind reads the provider identity, not the status code', () => {
  // A real credential fault, in both envelope shapes the gateway emits.
  assert.equal(authFaultKind({ code: AUTH_CODE, message: GATEWAY_AUTH_ERROR }), 'credential')
  assert.equal(
    authFaultKind({ code: AUTH_CODE, message: '{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}' }),
    'credential',
  )
  // The harness raises this one itself, after probing the value locally.
  assert.equal(authFaultKind({ code: INVALID_CREDENTIAL_CODE, message: 'blank value' }), 'credential')
  // A terse 401 with no body is still, on balance, a credential fault.
  assert.equal(authFaultKind({ code: AUTH_CODE, message: 'Client error 401 unauthorized' }), 'credential')

  // Model and region rejections ride the exact same statuses.
  assert.equal(authFaultKind({ code: AUTH_CODE, message: GATEWAY_MODEL_ERROR }), 'model')
  assert.equal(authFaultKind({ code: AUTH_CODE, message: GATEWAY_REGION_ERROR }), 'model')
  assert.equal(
    authFaultKind({ code: AUTH_CODE, message: '403 - This model is not available in your country.' }),
    'model',
    'the wording fallback covers providers that send no structured type',
  )

  // No recognizable identity: refuse to guess.
  assert.equal(authFaultKind({ code: AUTH_CODE, message: 'key rejected' }), 'unknown')
  assert.equal(authFaultKind({ code: AUTH_CODE, message: '' }), 'unknown')

  // Not credential-shaped at all — the transient path owns these.
  assert.equal(authFaultKind({ code: QUOTA_CODE, message: 'quota' }), null)
  assert.equal(authFaultKind({ code: 'RATE_LIMIT', message: 'slow down' }), null)
  assert.equal(authFaultKind(null), null)
})

test('a region-blocked model never marks a key invalid', () => {
  const pool = freshPool()
  pool.syncKeys(KEYS)
  // The failure that emptied this pool in production: the gateway answers 403
  // for a model it will not serve in this country and the harness labels it AUTH.
  const rotation = pool.onFailure('acc-a', { code: AUTH_CODE, message: GATEWAY_REGION_ERROR })
  assert.equal(rotation, null, 'every key would answer identically — rotate nothing')
  assert.equal(pool.stateOf('acc-a').state, 'healthy')
  assert.equal(pool.currentKey().id, 'acc-a')
  assert.equal(pool.usableCount(), 3)
  assert.match(pool.stateOf('acc-a').lastFailure.message, /RegionError/, 'the fact is still recorded for the card')
})

test('an unservable model (401 ModelError) never marks a key invalid', () => {
  const pool = freshPool()
  pool.syncKeys(KEYS)
  pool.onFailure('acc-a', { code: AUTH_CODE, message: GATEWAY_MODEL_ERROR })
  assert.equal(pool.stateOf('acc-a').state, 'healthy')
  assert.equal(pool.usableCount(), 3)
})

test('a region-blocked model cannot dry out the pool one key at a time', () => {
  const pool = freshPool()
  pool.syncKeys(KEYS)
  for (const key of ['acc-a', 'acc-b', 'acc-c']) {
    pool.onFailure(key, { code: AUTH_CODE, message: GATEWAY_REGION_ERROR })
  }
  assert.equal(pool.usableCount(), 3, 'the pool is exactly where it started')
  assert.equal(pool.currentKey().id, 'acc-a')
})

test('an unrecognized AUTH is reported, not turned into a dead key', () => {
  const pool = freshPool()
  pool.syncKeys(KEYS)
  const rotation = pool.onFailure('acc-a', { code: AUTH_CODE, message: 'key rejected' })
  assert.equal(rotation, null)
  assert.equal(pool.stateOf('acc-a').state, 'healthy')
  assert.equal(pool.stateOf('acc-a').failureStreak, 1, 'it still counts as a transient failure')
  assert.equal(pool.usableCount(), 3)
})

test('a recognized credential fault still marks the key invalid and rotates', () => {
  const pool = freshPool()
  pool.syncKeys(KEYS)
  const rotation = pool.onFailure('acc-a', { code: AUTH_CODE, message: GATEWAY_AUTH_ERROR })
  assert.deepEqual(rotation, { from: 'acc-a', to: 'acc-b' })
  assert.equal(pool.stateOf('acc-a').state, 'invalid')
  assert.equal(pool.lastSwitch.reason, 'invalid')
})

test('a pool poisoned by an older build heals itself on load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-suite-'))
  const stateFile = join(dir, 'pool.state.json')
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    activeId: null,
    lastSwitch: { from: 'acc-b', to: null, reason: 'invalid', at: '2026-09-14T09:26:47.023Z' },
    states: {
      // Written by a build that marked every key invalid for a region block.
      'acc-a': {
        state: 'invalid',
        usage: { rolling: { status: 'ok', percent: 0 }, weekly: null, monthly: null },
        lastFailure: { code: AUTH_CODE, message: GATEWAY_REGION_ERROR, at: '2026-09-14T09:26:44.554Z' },
        failureStreak: 0,
      },
      // A real credential fault: the mark stands.
      'acc-b': {
        state: 'invalid',
        usage: null,
        lastFailure: { code: AUTH_CODE, message: GATEWAY_AUTH_ERROR, at: '2026-09-14T09:26:47.023Z' },
        failureStreak: 0,
      },
    },
  }))

  const pool = new KeyPool({ stateFile })
  pool.syncKeys(KEYS)
  assert.equal(pool.stateOf('acc-a').state, 'healthy', 'the unsupported mark is dropped')
  assert.equal(pool.stateOf('acc-a').usage.rolling.percent, 0, 'the usage facts survive')
  assert.equal(pool.stateOf('acc-b').state, 'invalid', 'a proven credential fault is kept')
  assert.equal(pool.currentKey().id, 'acc-a', 'the pool is usable again without a manual un-mark')
})
