import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  DEFAULT_HEADERS,
  InjectionLog,
  NANOID_ALPHABET,
  NANOID_ALPHABET_URLSAFE,
  createEnvFallback,
  createSessionScope,
  headerPairs,
  hostnameOf,
  installSessionHeaderFetch,
  matchesTarget,
  nanoidOf,
  normalizeSessionConfig,
  observedIterable,
  scopedIterable,
  stripSessionPrefix,
  wireSessionIdOf,
  withSessionHeaders,
} from '../session.js'

/* ------------------------------------------------------------------ *
 * nanoid derivation
 * ------------------------------------------------------------------ */

/**
 * Independent reference: walk the SHA-256 bit stream 6 bits at a time using
 * BigInt arithmetic. Deliberately shares no code with the implementation, so a
 * mismatch means one of the two is wrong rather than that both agree on a bug.
 */
function referenceNanoid(input, length, alphabet) {
  const total = 256n
  let digest = BigInt(`0x${createHash('sha256').update(String(input)).digest('hex')}`)
  let out = ''
  let pos = 0n
  while (out.length < length) {
    if (pos + 6n > total) {
      pos = 0n
      digest = BigInt(`0x${createHash('sha256').update(String(input)).update(`#${out.length}`).digest('hex')}`)
    }
    const value = Number((digest >> (total - pos - 6n)) & 63n)
    pos += 6n
    if (value >= alphabet.length) continue
    out += alphabet[value]
  }
  return out
}

test('nanoidOf matches an independent BigInt bit-stream reference', () => {
  for (let i = 0; i < 200; i++) {
    const input = `seed-${i}`
    for (const length of [4, 8, 12, 32]) {
      for (const alphabet of [NANOID_ALPHABET, NANOID_ALPHABET_URLSAFE]) {
        assert.equal(
          nanoidOf(input, length, alphabet),
          referenceNanoid(input, length, alphabet),
          `mismatch for ${input}/${length}`,
        )
      }
    }
  }
})

test('nanoidOf is deterministic across calls, lengths, and alphabets', () => {
  const uuid = 'e820d21d-1234-5678-90ab-a309f722a3bc'
  assert.equal(nanoidOf(uuid), nanoidOf(uuid))
  assert.notEqual(nanoidOf(uuid), nanoidOf(`${uuid}x`))
  assert.equal(nanoidOf(uuid, 8).length, 8)
  assert.equal(nanoidOf(uuid, 32).length, 32)
  // The default alphabet is symbol-free so a gateway regex expecting pure
  // alphanumerics cannot miss a token.
  assert.match(nanoidOf(uuid), /^[A-Za-z0-9]{8}$/)
  assert.match(nanoidOf(uuid, 32), /^[A-Za-z0-9]{32}$/)
  // The url-safe alphabet may contain the two symbols the default excludes.
  const urlsafe = Array.from({ length: 400 }, (_, i) => nanoidOf(`u${i}`, 8, NANOID_ALPHABET_URLSAFE)).join('')
  assert.ok(urlsafe.includes('_') || urlsafe.includes('-'), 'urlsafe alphabet exposes its symbol range')
})

test('nanoidOf reaches every character of the default alphabet', () => {
  const seen = new Set()
  for (let i = 0; i < 4000; i++) for (const char of nanoidOf(`u${i}`, 8)) seen.add(char)
  assert.equal(seen.size, NANOID_ALPHABET.length)
})

test('stripSessionPrefix removes only the dsh label', () => {
  assert.equal(stripSessionPrefix('session-abc'), 'abc')
  assert.equal(stripSessionPrefix('abc'), 'abc')
  // Only a leading prefix; a uuid that merely contains the word is untouched.
  assert.equal(stripSessionPrefix('abc-session-def'), 'abc-session-def')
})

/* ------------------------------------------------------------------ *
 * Configuration normalization
 * ------------------------------------------------------------------ */

test('normalizeSessionConfig fills every default from nothing', () => {
  const cfg = normalizeSessionConfig(undefined)
  assert.equal(cfg.enabled, true)
  assert.deepEqual(cfg.headers, DEFAULT_HEADERS)
  assert.deepEqual(cfg.providers, ['opencode', 'opencode-go'])
  assert.deepEqual(cfg.hosts, ['opencode.ai'])
  assert.deepEqual(cfg.baseURLs, [])
  assert.equal(cfg.nanoidSessionId, true)
  assert.equal(cfg.nanoidLength, 8)
  assert.equal(cfg.nanoidAlphabet, 'alphanumeric')
  assert.equal(cfg.seedSessionId, false)
  assert.equal(cfg.verbose, false)
  assert.equal(cfg.disableFetchInjection, false)
})

test('normalizeSessionConfig survives every malformed shape a patch layer can send', () => {
  const cfg = normalizeSessionConfig({
    enabled: 'yes',
    headers: [],
    providers: [1, 'opencode', 'opencode'],
    hosts: ['opencode.ai', ''],
    baseURLs: 'nope',
    extraHeaders: { 'x-ok': 'v', 'bad name': 'v', '  ': 'v', 'x-num': 5 },
    userAgent: '   ',
    nanoidLength: 99,
    nanoidAlphabet: 'bogus',
  })
  assert.equal(cfg.enabled, true, 'only an explicit false disables')
  assert.deepEqual(cfg.headers, DEFAULT_HEADERS, 'an empty header list falls back to the defaults')
  assert.deepEqual(cfg.providers, ['opencode'])
  assert.deepEqual(cfg.hosts, ['opencode.ai'])
  assert.deepEqual(cfg.baseURLs, [])
  assert.deepEqual(cfg.extraHeaders, { 'x-ok': 'v' })
  assert.equal(cfg.userAgent, '')
  assert.equal(cfg.nanoidLength, 8, 'an out-of-range length falls back to 8')
  assert.equal(cfg.nanoidAlphabet, 'alphanumeric')
})

test('normalizeSessionConfig honors a deliberate false and a valid override', () => {
  const cfg = normalizeSessionConfig({
    enabled: false,
    nanoidSessionId: false,
    nanoidLength: 16,
    nanoidAlphabet: 'urlsafe',
    seedSessionId: true,
    verbose: true,
    headers: ['x-opencode-session'],
    extraHeaders: { 'x-opencode-client': 'native' },
    userAgent: 'opencode/1.2.3',
  })
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.nanoidSessionId, false)
  assert.equal(cfg.nanoidLength, 16)
  assert.equal(cfg.nanoidAlphabet, 'urlsafe')
  assert.equal(cfg.seedSessionId, true)
  assert.equal(cfg.verbose, true)
  assert.deepEqual(cfg.headers, ['x-opencode-session'])
  assert.equal(cfg.userAgent, 'opencode/1.2.3')
})

test('wireSessionIdOf hashes the uuid without the label, or passes the raw id through', () => {
  const cfg = normalizeSessionConfig(undefined)
  const raw = `session-${randomUUID()}`
  assert.equal(wireSessionIdOf(raw, cfg), nanoidOf(stripSessionPrefix(raw), 8, NANOID_ALPHABET))
  assert.notEqual(wireSessionIdOf(raw, cfg), raw)
  const off = normalizeSessionConfig({ nanoidSessionId: false })
  assert.equal(wireSessionIdOf(raw, off), raw)
})

test('headerPairs drops unusable names and values', () => {
  assert.deepEqual(headerPairs({ 'x-a': 'v', 'bad name': 'v', 'x-b': 1, 'x-c': '' }), { 'x-a': 'v' })
  assert.deepEqual(headerPairs(null), {})
  assert.deepEqual(headerPairs(['x-a']), {})
})

/* ------------------------------------------------------------------ *
 * Target matching
 * ------------------------------------------------------------------ */

test('matchesTarget matches a host suffix, a subdomain, and an exact base URL', () => {
  assert.equal(matchesTarget('https://opencode.ai/zen/go/v1/models', ['opencode.ai'], []), true)
  assert.equal(matchesTarget('https://api.opencode.ai/x', ['opencode.ai'], []), true)
  assert.equal(matchesTarget('https://opencode.ai.evil.test/x', ['opencode.ai'], []), false)
  assert.equal(matchesTarget('https://notopencode.ai/x', ['opencode.ai'], []), false)
  assert.equal(matchesTarget('https://gateway.internal/x', [], ['https://gateway.internal/']), true)
  assert.equal(matchesTarget('https://openai.com/v1', ['opencode.ai'], []), false)
  assert.equal(matchesTarget('not a url', ['opencode.ai'], []), false)
  assert.equal(matchesTarget('https://opencode.ai/x', ['.opencode.ai'], []), true, 'a leading dot is tolerated')
})

test('hostnameOf is total', () => {
  assert.equal(hostnameOf('https://API.Opencode.AI/x'), 'api.opencode.ai')
  assert.equal(hostnameOf('nonsense'), '')
  assert.equal(hostnameOf(undefined), '')
})

/* ------------------------------------------------------------------ *
 * Header rebuild
 * ------------------------------------------------------------------ */

test('withSessionHeaders preserves method, body, signal and every other init field', async () => {
  const controller = new AbortController()
  const body = 'a-body'
  const merged = withSessionHeaders(
    'https://opencode.ai/zen/go/v1/chat/completions',
    { method: 'POST', body, signal: controller.signal, keepalive: true, headers: { 'content-type': 'application/json' } },
    ['x-opencode-session'],
    'AbCd1234',
  )
  assert.equal(merged.input, 'https://opencode.ai/zen/go/v1/chat/completions')
  assert.equal(merged.init.method, 'POST')
  assert.equal(merged.init.body, body)
  assert.equal(merged.init.signal, controller.signal)
  assert.equal(merged.init.keepalive, true)
  assert.equal(merged.init.headers.get('content-type'), 'application/json')
  assert.equal(merged.init.headers.get('x-opencode-session'), 'AbCd1234')
})

test('withSessionHeaders adds extra headers and a User-Agent override', () => {
  const merged = withSessionHeaders('https://opencode.ai/x', {}, ['x-opencode-session'], 'tok', { 'x-opencode-client': 'native' }, 'opencode/1.2.3')
  assert.equal(merged.init.headers.get('x-opencode-client'), 'native')
  assert.equal(merged.init.headers.get('user-agent'), 'opencode/1.2.3')
})

test('withSessionHeaders returns null when a Request cannot be rebuilt', () => {
  // An already-consumed Request body cannot be re-wrapped with new headers; the
  // caller must pass the original call through rather than lose the body.
  const request = new Request('https://opencode.ai/x', { method: 'POST', body: 'abc' })
  void request.text()
  const rebuilt = withSessionHeaders(request, undefined, ['x-opencode-session'], 'tok')
  assert.equal(rebuilt, null)
})

/* ------------------------------------------------------------------ *
 * Session scoping
 * ------------------------------------------------------------------ */

async function* gen(values) {
  for (const value of values) yield value
}

test('scopedIterable binds the session id for every pull, and stays isolated across streams', async () => {
  const scope = createSessionScope()
  const observed = []
  const upstream = async function* (label) {
    for (let i = 0; i < 3; i++) {
      // Yield control so the two streams interleave: a scope that leaked
      // between them would show the wrong id here.
      await new Promise(resolve => setImmediate(resolve))
      observed.push(`${label}:${scope.current()}`)
      yield i
    }
  }
  const a = scopedIterable(scope, 'session-a', upstream('a'))
  const b = scopedIterable(scope, 'session-b', upstream('b'))
  const collected = []
  for (let i = 0; i < 3; i++) {
    collected.push((await a.next()).value, (await b.next()).value)
  }
  assert.deepEqual(collected, [0, 0, 1, 1, 2, 2])
  assert.deepEqual(observed, ['a:session-a', 'b:session-b', 'a:session-a', 'b:session-b', 'a:session-a', 'b:session-b'])
})

test('scopedIterable returns the same chunks and honors early return', async () => {
  const scope = createSessionScope()
  const scoped = scopedIterable(scope, 's', gen([1, 2, 3]))
  assert.equal((await scoped.next()).value, 1)
  await scoped.return()
  assert.equal((await scoped.next()).done, true)
  // A `return` on an exhausted source still settles instead of hanging.
  const empty = scopedIterable(scope, 's', gen([]))
  assert.equal((await empty.next()).done, true)
})

/* ------------------------------------------------------------------ *
 * The fetch wrapper
 * ------------------------------------------------------------------ */

/**
 * The process's real fetch, captured once at module load. Every helper below
 * restores to THIS rather than to "whatever was installed when I started":
 * a helper that captures its own baseline leaks when two of them are nested
 * inside one test, because the second one captures the first one's stub.
 */
const REAL_FETCH = globalThis.fetch

/** Install the wrapper against a stub global fetch, returning the calls it saw. */
function withStubFetch(t, config, session) {
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init })
    return { ok: true }
  }
  const injections = new InjectionLog(5)
  const restore = installSessionHeaderFetch({
    getConfig: () => config,
    getSession: () => session,
    injections,
  })
  t.after(() => {
    restore()
    globalThis.fetch = REAL_FETCH
  })
  return { calls, injections }
}

const ON = normalizeSessionConfig(undefined)

test('the wrapper tags opencode requests and leaves every other host alone', async (t) => {
  const { calls, injections } = withStubFetch(t, ON, { sessionId: 'session-abc', token: 'AbCd1234' })
  await globalThis.fetch('https://opencode.ai/zen/go/v1/chat/completions', { method: 'POST', body: 'x' })
  await globalThis.fetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST', body: 'y' })

  const opencode = calls[0]
  assert.equal(opencode.init.headers.get('x-opencode-session'), 'AbCd1234')
  assert.equal(opencode.init.headers.get('x-session-affinity'), 'AbCd1234')
  assert.equal(opencode.init.headers.get('x-client-request-id'), 'AbCd1234')
  assert.equal(opencode.init.headers.get('x-session-id'), 'AbCd1234')
  assert.equal(opencode.init.body, 'x', 'the body is never touched')
  assert.equal(opencode.init.method, 'POST')

  const other = calls[1]
  assert.equal(other.init.headers, undefined, 'a non-opencode call is handed over with identical arguments')
  assert.equal(other.init.body, 'y')

  assert.equal(injections.list().length, 1)
  assert.equal(injections.list()[0].token, 'AbCd1234')
  assert.equal(injections.list()[0].error, null)
})

test('the wrapper is an exact pass-through when disabled or not targeted', async (t) => {
  const off = normalizeSessionConfig({ enabled: false })
  const { calls } = withStubFetch(t, off, { sessionId: 'session-abc', token: 'AbCd1234' })
  const init = { method: 'POST', body: 'x' }
  await globalThis.fetch('https://opencode.ai/zen/go/v1/chat/completions', init)
  assert.equal(calls[0].init, init, 'the very same init object is forwarded')

  const noFetchInjection = normalizeSessionConfig({ disableFetchInjection: true })
  const { calls: calls2 } = withStubFetch(t, noFetchInjection, { sessionId: 'session-abc', token: 'AbCd1234' })
  await globalThis.fetch('https://opencode.ai/zen/go/v1/chat/completions', init)
  assert.equal(calls2[0].init, init)
})

test('the wrapper skips injection when there is no session id', async (t) => {
  const { calls } = withStubFetch(t, ON, undefined)
  const init = { method: 'POST' }
  await globalThis.fetch('https://opencode.ai/x', init)
  assert.equal(calls[0].init, init)
})

test('the wrapper reads its configuration live, so a settings edit applies without reinstalling', async (t) => {
  const config = { ...ON }
  const { calls } = withStubFetch(t, config, { sessionId: 'session-abc', token: 'AbCd1234' })
  config.headers = ['x-opencode-session']
  config.hosts = ['gateway.internal']
  await globalThis.fetch('https://opencode.ai/x', {})
  assert.equal(calls[0].init.headers, undefined, 'opencode.ai is no longer a target')
  await globalThis.fetch('https://gateway.internal/x', {})
  assert.equal(calls[1].init.headers.get('x-opencode-session'), 'AbCd1234')
  assert.equal(calls[1].init.headers.get('x-session-affinity'), null, 'the narrowed header list applies')
})

test('the wrapper records the wire headers it actually set', async (t) => {
  const cfg = normalizeSessionConfig({ extraHeaders: { 'x-opencode-client': 'native' }, userAgent: 'opencode/1.2.3' })
  const { injections } = withStubFetch(t, cfg, { sessionId: 'session-abc', token: 'tok12345' })
  await globalThis.fetch('https://opencode.ai/x', {})
  const [entry] = injections.list()
  assert.equal(entry.sessionId, 'session-abc')
  assert.ok(entry.headers.includes('x-opencode-session: tok12345'))
  assert.ok(entry.headers.includes('x-opencode-client: native'))
  assert.ok(entry.headers.includes('user-agent: opencode/1.2.3'))
})

test('disposal restores the previous fetch, and never clobbers a later wrapper', async (t) => {
  // Explicit baseline: this test is about the install chain itself, so it must
  // not depend on what any earlier test left behind.
  assert.equal(globalThis.fetch, REAL_FETCH, 'no earlier test leaked a fetch wrapper')
  const first = installSessionHeaderFetch({ getConfig: () => ON, getSession: () => undefined })
  const firstWrapper = globalThis.fetch
  assert.notEqual(firstWrapper, REAL_FETCH)
  // A second mount replaces the first; disposing the first must not tear the
  // second out from under the other plugin.
  const second = installSessionHeaderFetch({ getConfig: () => ON, getSession: () => undefined })
  assert.notEqual(globalThis.fetch, firstWrapper)
  first()
  assert.notEqual(globalThis.fetch, REAL_FETCH, 'the later wrapper survives')
  second()
  // Unwinding must skip the first wrapper: it is already disposed, so restoring
  // it would leave a dead link between the caller and the real fetch.
  assert.equal(globalThis.fetch, REAL_FETCH)
  t.after(() => { globalThis.fetch = REAL_FETCH })
})

test('a wrapper installed on top keeps injecting after the one below is disposed', async (t) => {
  assert.equal(globalThis.fetch, REAL_FETCH)
  const delegateCalls = []
  const realDelegate = async (input, init) => {
    delegateCalls.push({ input, init })
    return { ok: true }
  }
  // Stand in for "the real fetch" so the delegate is observable, then build the
  // chain the harness produces when one plugin mounts over another.
  globalThis.fetch = realDelegate
  try {
    const below = installSessionHeaderFetch({ getConfig: () => ON, getSession: () => undefined })
    const above = installSessionHeaderFetch({
      getConfig: () => ON,
      getSession: () => ({ sessionId: 's', token: 'tok12345' }),
    })

    // Disposing a wrapper that is NOT on top must change nothing at all.
    below()
    await globalThis.fetch('https://opencode.ai/x', {})
    assert.equal(delegateCalls.length, 1)
    assert.equal(delegateCalls[0].init.headers.get('x-opencode-session'), 'tok12345',
      'the wrapper on top still injects')

    // Unwinding from the top must skip the disposed link and land on the
    // delegate, not on a dead wrapper that would swallow our headers.
    above()
    assert.equal(globalThis.fetch, realDelegate)
    await globalThis.fetch('https://opencode.ai/x', {})
    assert.equal(delegateCalls.length, 2)
    assert.equal(delegateCalls[1].init.headers, undefined, 'nothing is injected any more')
  } finally {
    globalThis.fetch = REAL_FETCH
  }
  t.after(() => { globalThis.fetch = REAL_FETCH })
})

test('the injection log keeps only the newest entries', () => {
  const log = new InjectionLog(2)
  log.record({ url: 'a', headers: [], sessionId: 's', token: 't' })
  log.record({ url: 'b', headers: [], sessionId: 's', token: 't' })
  log.record({ url: 'c', headers: [], sessionId: 's', token: 't', error: 'skipped' })
  const listed = log.list()
  assert.deepEqual(listed.map(entry => entry.url), ['c', 'b'])
  assert.equal(listed[0].error, 'skipped')
  assert.equal(listed[1].error, null)
  log.clear()
  assert.deepEqual(log.list(), [])
})

/* ------------------------------------------------------------------ *
 * Environment fallback
 * ------------------------------------------------------------------ */

test('the env fallback prefers its configured variable, then DSH_SESSION_ID, then a stable uuid', () => {
  const saved = { ...process.env }
  try {
    process.env.DSH_SESSION_ID = 'from-dsh'
    process.env.OC_TEST_SID = 'from-configured'
    assert.equal(createEnvFallback('OC_TEST_SID')(), 'from-configured')
    delete process.env.OC_TEST_SID
    assert.equal(createEnvFallback('OC_TEST_SID')(), 'from-dsh')
    delete process.env.DSH_SESSION_ID
    const fallback = createEnvFallback('')
    const first = fallback()
    assert.equal(fallback(), first, 'the random fallback is stable for the process')
    assert.match(first, /^[0-9a-f-]{36}$/)
  } finally {
    for (const key of ['DSH_SESSION_ID', 'OC_TEST_SID']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})

test('the env fallback reads its variable name live', () => {
  const saved = process.env.OC_LIVE_SID
  try {
    delete process.env.OC_LIVE_SID
    let name = ''
    const fallback = createEnvFallback(() => name)
    const withoutVariable = fallback()
    process.env.OC_LIVE_SID = 'appeared-later'
    name = 'OC_LIVE_SID'
    assert.equal(fallback(), 'appeared-later')
    assert.notEqual(withoutVariable, 'appeared-later')
  } finally {
    if (saved === undefined) delete process.env.OC_LIVE_SID
    else process.env.OC_LIVE_SID = saved
  }
})

test('observedIterable reports usage chunks and passes every chunk through', async () => {
  const seen = []
  const chunks = [
    { type: 'text', text: 'a' },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
    { type: 'text', text: 'b' },
  ]
  const source = {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  const seenOut = []
  for await (const chunk of observedIterable(source, usage => seen.push(usage))) seenOut.push(chunk)
  assert.deepEqual(seenOut, chunks)
  assert.deepEqual(seen, [{ inputTokens: 3, outputTokens: 1 }])
})

test('observedIterable survives a throwing observer and a non-usage chunk', async () => {
  const source = {
    async *[Symbol.asyncIterator]() {
      yield { type: 'usage', usage: { inputTokens: 1 } }
      yield { type: 'done' }
    },
  }
  const out = []
  const wrapped = observedIterable(source, () => { throw new Error('accounting exploded') })
  for await (const chunk of wrapped) out.push(chunk.type)
  assert.deepEqual(out, ['usage', 'done'])
})
