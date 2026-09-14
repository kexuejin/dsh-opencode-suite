import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ASSUMED_CONTEXT_WINDOW,
  ASSUMED_MAX_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  OFFICIAL_FREE_MODEL_IDS,
  SETTINGS_NS,
  TIERS,
  TIER_IDS,
  assertIdList,
  buildRoutePatch,
  capacitiesFor,
  diffEntries,
  displayNameFromId,
  dynamicModelDescriptor,
  fetchModelListings,
  filterFreeTierLive,
  loadModelsCache,
  mergeEntries,
  normalizeEntry,
  parseListing,
  removeEntries,
  saveModelsCache,
  tierByRoute,
  withDeclaredInput,
} from '../catalog.js'

/* ------------------------------------------------------------------ *
 * Tier table
 * ------------------------------------------------------------------ */

test('the tier table matches the official endpoint layout', () => {
  assert.deepEqual(TIER_IDS, ['free', 'go'])
  assert.equal(TIERS.free.route, 'opencode')
  assert.equal(TIERS.go.route, 'opencode-go')
  assert.equal(TIERS.free.baseURL, 'https://opencode.ai/zen/v1')
  assert.equal(TIERS.go.baseURL, 'https://opencode.ai/zen/go/v1')
  // The two tiers must never share a route, or one would silently overwrite.
  assert.notEqual(TIERS.free.route, TIERS.go.route)
  assert.equal(SETTINGS_NS, 'llm-pi-ai')
})

test('tierByRoute maps back and rejects unmanaged routes', () => {
  assert.equal(tierByRoute('opencode').id, 'free')
  assert.equal(tierByRoute('opencode-go').id, 'go')
  assert.equal(tierByRoute('deepseek'), undefined)
})

/* ------------------------------------------------------------------ *
 * displayNameFromId
 * ------------------------------------------------------------------ */

test('displayNameFromId capitalizes words and keeps version digits intact', () => {
  assert.equal(displayNameFromId('deepseek-v4-pro'), 'Deepseek V4 Pro')
  assert.equal(displayNameFromId('x-preview-f-free'), 'X Preview F Free')
  assert.equal(displayNameFromId('mimo-v2.5-free'), 'Mimo V2.5 Free')
  assert.equal(displayNameFromId('nemotron_3_ultra'), 'Nemotron 3 Ultra')
  assert.equal(displayNameFromId(''), '')
})

/* ------------------------------------------------------------------ *
 * Listing parsing
 * ------------------------------------------------------------------ */

test('parseListing accepts the OpenAI envelope, a bare array, and bare ids', () => {
  const envelope = parseListing({ object: 'list', data: [{ id: 'a' }, { id: 'b', name: 'Bee' }] })
  assert.deepEqual(envelope, [{ id: 'a', name: 'A' }, { id: 'b', name: 'Bee' }])
  assert.deepEqual(parseListing(['x', 'y']), [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }])
  assert.deepEqual(parseListing([{ id: 'z' }]), [{ id: 'z', name: 'Z' }])
})

test('parseListing dedupes, keeps endpoint order, and drops unusable rows', () => {
  const parsed = parseListing([
    { id: 'a' },
    { id: 'a', name: 'second wins?' },
    { noId: true },
    { id: '' },
    null,
    'b',
  ])
  assert.deepEqual(parsed.map(entry => entry.id), ['a', 'b'])
  // First occurrence wins: the endpoint's own ordering is authoritative.
  assert.equal(parsed[0].name, 'A')
})

test('parseListing tolerates junk bodies without throwing', () => {
  for (const body of [null, undefined, 42, 'text', {}, { data: 'nope' }]) {
    assert.deepEqual(parseListing(body), [])
  }
})

/* ------------------------------------------------------------------ *
 * fetchModelListings
 * ------------------------------------------------------------------ */

function fakeResponse(status, body, ok) {
  return {
    status,
    ok: ok ?? (status >= 200 && status < 300),
    async json() {
      if (body === undefined) throw new Error('not json')
      return body
    },
  }
}

test('fetchModelListings sends the bearer key only when one is given', async () => {
  const seen = []
  const impl = async (url, init) => {
    seen.push({ url, headers: init.headers })
    return fakeResponse(200, { data: [{ id: 'm' }] })
  }
  await fetchModelListings({ baseUrl: 'https://opencode.ai/zen/go/v1/models', apiKey: 'sk-x', fetchImpl: impl })
  assert.equal(seen[0].headers.Authorization, 'Bearer sk-x')
  await fetchModelListings({ baseUrl: 'https://opencode.ai/zen/go/v1/models', fetchImpl: impl })
  assert.equal('Authorization' in seen[1].headers, false)
  // The session-header family must not leak onto these gateway calls.
  assert.equal('x-opencode-session' in seen[0].headers, false)
})

test('fetchModelListings classifies 401, HTTP errors, bad JSON and network failure', async () => {
  const at = status => async () => fakeResponse(status, {})
  await assert.rejects(
    fetchModelListings({ baseUrl: 'u', fetchImpl: at(401) }),
    err => err.code === 'unauthorized',
  )
  await assert.rejects(
    fetchModelListings({ baseUrl: 'u', fetchImpl: at(503) }),
    err => err.code === 'http-503',
  )
  await assert.rejects(
    fetchModelListings({ baseUrl: 'u', fetchImpl: async () => fakeResponse(200, undefined) }),
    err => err.code === 'bad-json',
  )
  await assert.rejects(
    fetchModelListings({ baseUrl: 'u', fetchImpl: async () => { throw new Error('offline') } }),
    err => err.code === 'network',
  )
})

/* ------------------------------------------------------------------ *
 * Entry normalization
 * ------------------------------------------------------------------ */

test('normalizeEntry derives a name and defaults input to text', () => {
  const result = normalizeEntry({ id: 'x-preview-f-free', contextWindow: 200000, maxTokens: 64000 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.entry, {
    id: 'x-preview-f-free',
    name: 'X Preview F Free',
    contextWindow: 200000,
    maxTokens: 64000,
    input: ['text'],
  })
})

test('normalizeEntry refuses missing capacities unless assumeDefaults is set', () => {
  const strict = normalizeEntry({ id: 'a' })
  assert.equal(strict.ok, false)
  assert.equal(strict.errors.length, 2)
  const assumed = normalizeEntry({ id: 'a' }, { assumeDefaults: true })
  assert.equal(assumed.ok, true)
  assert.equal(assumed.entry.contextWindow, ASSUMED_CONTEXT_WINDOW)
  assert.equal(assumed.entry.maxTokens, ASSUMED_MAX_TOKENS)
})

test('normalizeEntry validates capacities, modalities and reasoning efforts', () => {
  assert.equal(normalizeEntry({ id: 'a', contextWindow: 0, maxTokens: 1 }).ok, false)
  assert.equal(normalizeEntry({ id: 'a', contextWindow: 1.5, maxTokens: 1 }).ok, false)
  assert.equal(normalizeEntry({ id: 'a', contextWindow: 1, maxTokens: 1, input: ['audio'] }).ok, false)
  assert.equal(normalizeEntry({ id: 'a', contextWindow: 1, maxTokens: 1, input: [] }).entry.input[0], 'text')
  const efforts = normalizeEntry({
    id: 'a',
    contextWindow: 1,
    maxTokens: 1,
    input: ['text', 'image'],
    reasoningEfforts: { high: 'high', max: 'max', low: null },
  })
  assert.deepEqual(efforts.entry.reasoningEfforts, { high: 'high', max: 'max', low: null })
  assert.equal(normalizeEntry({ id: 'a', contextWindow: 1, maxTokens: 1, reasoningEfforts: false }).entry.reasoningEfforts, false)
  assert.equal(normalizeEntry({ id: 'a', contextWindow: 1, maxTokens: 1, reasoningEfforts: { bogus: 'x' } }).ok, false)
})

test('normalizeEntry rejects a non-object and an empty id', () => {
  assert.equal(normalizeEntry(null).ok, false)
  assert.equal(normalizeEntry([]).ok, false)
  assert.equal(normalizeEntry({ contextWindow: 1, maxTokens: 1 }).ok, false)
})

/* ------------------------------------------------------------------ *
 * assertIdList
 * ------------------------------------------------------------------ */

test('assertIdList trims, dedupes, and refuses blanks', () => {
  assert.deepEqual(assertIdList(['a', ' b ', 'a'], 'models'), ['a', 'b'])
  assert.deepEqual(assertIdList([], 'models'), [])
  assert.throws(() => assertIdList('a', 'models'), /must be an array/)
  assert.throws(() => assertIdList(['a', '  '], 'models'), /non-empty/)
  assert.throws(() => assertIdList([1], 'models'), /non-empty/)
})

/* ------------------------------------------------------------------ *
 * Drift / merge / remove
 * ------------------------------------------------------------------ */

test('diffEntries reports both directions in stable order', () => {
  const configured = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const live = [{ id: 'b' }, { id: 'd' }, { id: 'a' }]
  assert.deepEqual(diffEntries(configured, live), { added: ['d'], stale: ['c'] })
  assert.deepEqual(diffEntries([], live), { added: ['b', 'd', 'a'], stale: [] })
})

test('mergeEntries never overwrites an existing id', () => {
  const existing = [{ id: 'a', name: 'A', contextWindow: 999 }]
  const { merged, addedIds, skippedIds } = mergeEntries(existing, [
    { id: 'a', name: 'A2', contextWindow: 1 },
    { id: 'b', name: 'B', contextWindow: 2 },
  ])
  assert.deepEqual(addedIds, ['b'])
  assert.deepEqual(skippedIds, ['a'])
  assert.equal(merged[0].contextWindow, 999, 'the corrected capacity survives')
  assert.equal(merged.length, 2)
})

test('removeEntries reports ids it could not find', () => {
  const { merged, removedIds, notFoundIds } = removeEntries([{ id: 'a' }, { id: 'b' }], ['a', 'zz'])
  assert.deepEqual(merged.map(entry => entry.id), ['b'])
  assert.deepEqual(removedIds, ['a'])
  assert.deepEqual(notFoundIds, ['zz'])
})

test('filterFreeTierLive drops paid ids but keeps configured ones', () => {
  const live = [
    { id: 'big-pickle' },
    { id: 'deepseek-v4-flash-free' },
    { id: 'muse-spark-1.2-contributor-free' },
    { id: 'mine' },
  ]
  // The allowlist is the docs' free table; a paid id riding the same endpoint
  // must not count as free, while a user-configured id stays managed.
  assert.deepEqual(filterFreeTierLive(live, ['mine']).map(entry => entry.id), ['big-pickle', 'mine'])
  assert.deepEqual(filterFreeTierLive(live, []).map(entry => entry.id), ['big-pickle'])
  for (const id of OFFICIAL_FREE_MODEL_IDS) {
    assert.ok(filterFreeTierLive([{ id }], []).length === 1, `${id} must be in the allowlist`)
  }
})

test('the free allowlist encodes the docs table, not the -free suffix', () => {
  // Verified 2026-09-14 against https://opencode.ai/docs/zen/ (every pricing
  // row marked "Free") and the live https://opencode.ai/zen/v1/models listing.
  // When this fails, the upstream free set has moved: re-read the docs table
  // and update the constant rather than only this expectation.
  assert.deepEqual(OFFICIAL_FREE_MODEL_IDS, [
    'big-pickle',
    'mimo-v2.5-free',
    'ling-3.0-flash-fin-free',
    'nemotron-3-ultra-free',
    'nemotron-3.5-lightning-free',
    'muse-spark-1.3-contributor-free',
  ])

  // A free model with no suffix proves the suffix is a naming habit, not the
  // rule: anything that filtered on `endsWith('-free')` would lose it.
  assert.ok(OFFICIAL_FREE_MODEL_IDS.includes('big-pickle'), 'big-pickle is free without a suffix')

  // Suffix-only ids the free endpoint also advertises stay out of the list.
  for (const paid of ['deepseek-v4-flash-free', 'muse-spark-1.2-contributor-free']) {
    assert.ok(!OFFICIAL_FREE_MODEL_IDS.includes(paid), `${paid} is suffix-only, not a free table row`)
  }
})

test('buildRoutePatch replaces exactly one route', () => {
  assert.deepEqual(buildRoutePatch('opencode', []), { providers: { opencode: { models: [] } } })
})

/* ------------------------------------------------------------------ *
 * Synthesized descriptors
 * ------------------------------------------------------------------ */

test('capacitiesFor prefers a configuration override and names the source', () => {
  const overrides = { m: { contextWindow: 200000, maxTokens: 64000 } }
  assert.deepEqual(capacitiesFor('m', overrides), {
    contextWindow: 200000,
    maxTokens: 64000,
    source: 'configured',
  })
  assert.deepEqual(capacitiesFor('other', overrides), {
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    source: 'default',
  })
  // A half-filled override is not an override.
  assert.equal(capacitiesFor('m', { m: { contextWindow: 1 } }).source, 'default')
})

test('dynamicModelDescriptor always carries a zero cost block', () => {
  const descriptor = dynamicModelDescriptor('new-model', '', 'opencode-go', capacitiesFor('new-model', {}))
  // The pi-ai usage pipeline calls calculateCost() on every completed stream and
  // iterates model.cost.tiers; a missing cost block crashes the whole round.
  assert.deepEqual(descriptor.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(descriptor.input, ['text'])
  assert.equal(descriptor.name, 'New Model')
  assert.equal(descriptor.api, 'openai-completions')
  assert.equal(descriptor.baseUrl, TIERS.go.baseURL)
  assert.deepEqual(descriptor.thinkingLevelMap, { minimal: null, low: null, medium: null, high: 'high', max: 'max' })
  assert.equal(descriptor.compat.thinkingFormat, 'deepseek')
})

test('withDeclaredInput copies rather than mutating the shared catalog object', () => {
  const original = { id: 'm', input: ['text'] }
  const declared = withDeclaredInput(original, ['m'])
  assert.deepEqual(declared.input, ['text', 'image'])
  assert.deepEqual(original.input, ['text'], 'the catalog object is shared with every other consumer')
  // A model the catalog already declares image-capable is left alone.
  const already = { id: 'm', input: ['text', 'image'] }
  assert.equal(withDeclaredInput(already, ['m']), already)
  // An undeclared model is left alone.
  assert.equal(withDeclaredInput(original, ['other']), original)
  // A descriptor without an input array must not throw.
  assert.doesNotThrow(() => withDeclaredInput({ id: 'm' }, ['m']))
})

/* ------------------------------------------------------------------ *
 * Fetched-lineup cache
 * ------------------------------------------------------------------ */

test('the models cache round-trips per route and ignores junk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-suite-'))
  const path = join(dir, 'models.json')
  const cache = new Map([
    ['opencode-go', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]],
    ['opencode', [{ id: 'c', name: 'C' }]],
  ])
  saveModelsCache(path, cache)
  const loaded = loadModelsCache(path)
  assert.deepEqual(loaded.get('opencode-go'), [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
  assert.deepEqual(loaded.get('opencode'), [{ id: 'c', name: 'C' }])
  assert.ok(readFileSync(path, 'utf8').includes('"version": 1'))
})

test('loadModelsCache returns empty for a missing, corrupt, or foreign-version file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-suite-'))
  assert.equal(loadModelsCache(join(dir, 'absent.json')).size, 0)

  const corrupt = join(dir, 'corrupt.json')
  writeFileSync(corrupt, '{not json')
  assert.equal(loadModelsCache(corrupt).size, 0)

  // A file written by a different version must not be reinterpreted: the
  // loader keys on its own format version and starts fresh otherwise.
  const foreign = join(dir, 'foreign.json')
  writeFileSync(foreign, JSON.stringify({ version: 99, routes: { 'opencode-go': [{ id: 'a' }] } }))
  assert.equal(loadModelsCache(foreign).size, 0)

  const noVersion = join(dir, 'noversion.json')
  writeFileSync(noVersion, JSON.stringify({ routes: { 'opencode-go': [{ id: 'a' }] } }))
  assert.equal(loadModelsCache(noVersion).size, 0)
})

test('loadModelsCache drops malformed entries but keeps the usable ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencode-suite-'))
  const path = join(dir, 'partial.json')
  writeFileSync(path, JSON.stringify({
    version: 1,
    routes: {
      'opencode-go': [{ id: 'a', name: 'A' }, { name: 'no id' }, null, 'bare', { id: 'b' }],
      'opencode': 'not an array',
    },
  }))
  const loaded = loadModelsCache(path)
  assert.deepEqual(loaded.get('opencode-go'), [{ id: 'a', name: 'A' }, { id: 'b', name: 'b' }])
  assert.equal(loaded.has('opencode'), false)
})
