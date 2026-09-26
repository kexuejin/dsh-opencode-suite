/**
 * Session-header injection for opencode endpoints.
 *
 * opencode threads its current session id through the provider call options and
 * emits `x-session-affinity` / `x-client-request-id` on every wire request
 * (plus `x-opencode-session` on the opencode gateway branch). The harness
 * supplies the id — `dsh-agent-loop` fills `options.sessionId` and the pi-ai
 * adapter forwards it — but two design walls keep it off the wire: the adapter
 * withholds `sendSessionAffinityHeaders` / `sessionAffinityFormat` from its
 * provider compat gate, and it drops per-request `options.headers` (it sends
 * only the static `headers` of the provider profile plus attribution headers).
 * This module closes the gap at the layer that cannot be bypassed:
 *
 *  1. `scopedIterable` runs every pull of the `llm/stream` waterfall result
 *     inside an AsyncLocalStorage scope holding the conversation session id, so
 *     the id is correct per request even when several conversations stream
 *     concurrently. Chunks and call options pass through unchanged.
 *  2. `installSessionHeaderFetch` wraps `globalThis.fetch` (the undici fetch
 *     both the `openai` and `@anthropic-ai/sdk` clients resolve to on Node ≥ 18)
 *     and adds the session-id headers to every request whose URL targets an
 *     opencode endpoint (host suffix or exact base URL, both configurable).
 *
 * **Scope guarantee — only request headers change.** The fetch wrapper never
 * reads, rewrites, or replaces the request body (bytes and streams pass through
 * untouched), never changes the URL, method, signal, credentials, `duplex`, or
 * any other fetch option, and never touches responses. Calls that do not match
 * an opencode endpoint are handed to the original fetch with the exact same
 * arguments. The waterfall listener does not modify call options by default;
 * only with `seedSessionId: true` does it fill a missing `options.sessionId`
 * for the configured opencode routes, whose only wire effect is (session)
 * request headers.
 *
 * Harness-free: the host plugin wires these, and `node --test` drives them
 * directly.
 *
 * @module dsh-opencode-suite/session
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'

/**
 * Default session headers opencode itself emits on requests:
 *
 * - `x-opencode-session` — the session id header on the opencode gateway
 *   branch (providers whose id starts with `opencode`); this is the one the
 *   ZEN gateway keys sessions on.
 * - `x-session-affinity` / `x-client-request-id` / `x-session-id` — the
 *   affinity family opencode sends on every other (OpenAI-compatible) provider
 *   branch; harmless duplicates on the gateway branch.
 */
export const DEFAULT_HEADERS = ['x-opencode-session', 'x-session-affinity', 'x-client-request-id', 'x-session-id']

/** Provider routes whose sessionId gets tagged, by default. */
export const DEFAULT_PROVIDERS = ['opencode', 'opencode-go']

/** URL host suffixes that get session headers, by default. */
export const DEFAULT_HOSTS = ['opencode.ai']

/**
 * Deterministic token alphabet, symbol-free (62 chars = alphanumeric only).
 * The default wire-token alphabet: `_`/`-` are legal nanoid, but a gateway
 * regex that expects pure alphanumerics could miss them, so the default avoids
 * symbols; 6-bit digest values 62/63 are skipped (rejection sampling) to keep
 * the 62-char alphabet uniform.
 */
export const NANOID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
/** nanoid's classic URL-safe alphabet with `_` and `-` (64 chars = 2^6). */
export const NANOID_ALPHABET_URLSAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
/** Config value → alphabet table. */
export const NANOID_ALPHABETS = { alphanumeric: NANOID_ALPHABET, urlsafe: NANOID_ALPHABET_URLSAFE }

/** HTTP header-name grammar (RFC 9110 token). */
const HEADER_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * Deterministic hash of a session id into opencode-style nanoid format.
 * SHA-256 the input, walk the digest 6 bits at a time, emit `length`
 * characters (default 8, like the opencode web token `QBgzdhtO`). The same
 * input always maps to the same token — across requests and process restarts —
 * so a gateway that keys on the token can attribute a dsh conversation. Pure
 * function; no randomness involved.
 * @param input - the string to hash.
 * @param length - token length (default 8).
 * @param alphabet - allowed characters (62–64 unique chars).
 */
export function nanoidOf(input, length = 8, alphabet = NANOID_ALPHABET) {
  // `let`, not `const`: the re-hash below only triggers under heavy rejection
  // sampling, which a 62-char alphabet makes unreachable in practice — but a
  // `const` there would turn an unreachable branch into a TypeError.
  let digest = createHash('sha256').update(String(input)).digest()
  const size = alphabet.length
  let out = ''
  let bit = 0
  while (out.length < length) {
    if (bit + 6 > digest.length * 8) {
      // Ran past this digest block (only reachable through heavy rejection
      // sampling): hash again with a counter for fresh bytes.
      digest = createHash('sha256').update(String(input)).update(`#${out.length}`).digest()
      bit = 0
    }
    const byteIndex = bit >> 3
    const bitOffset = bit & 7
    let value
    if (bitOffset <= 2) {
      // 6 bits fit inside one digest byte.
      value = (digest[byteIndex] >> (2 - bitOffset)) & 0x3f
    } else {
      // Spans two digest bytes: take the trailing bits of this byte and the
      // leading bits of the next.
      value = ((digest[byteIndex] & ((1 << (8 - bitOffset)) - 1)) << (bitOffset - 2))
        | (digest[byteIndex + 1] >> (10 - bitOffset))
    }
    value &= 0x3f
    bit += 6
    if (value >= size) continue // rejection sampling: uniform over the alphabet
    out += alphabet[value]
  }
  return out
}

/**
 * Strip the dsh `session-` prefix so the wire token hashes only the uuid part
 * (`e820d21d-…-a309f722a3bc`), independent of the label. Ids without the prefix
 * (env fallback / random uuid) pass through unchanged.
 */
export function stripSessionPrefix(id) {
  return String(id).replace(/^session-/, '')
}

/** Pair validation for `extraHeaders`, `userAgent` and the header list. */
export function headerPairs(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out = {}
  for (const [headerName, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== 'string') continue
    const name = headerName.trim()
    if (!HEADER_NAME_TOKEN.test(name) || headerValue.length === 0) continue
    out[name] = headerValue
  }
  return out
}

/**
 * Tolerate every shape a patch layer, a settings document, or the card may
 * deliver; defaults apply per key. No input throws — a bad value falls back to
 * its default rather than disabling injection for the whole deployment.
 * @param config - the raw `sessionHeaders` block (or undefined).
 * @returns a fully-populated, validated configuration.
 */
export function normalizeSessionConfig(config) {
  const c = config ?? {}
  // Every string list is filtered the same way: drop non-strings and blanks,
  // de-duplicate, and fall back to the documented default when nothing viable
  // survives. Deduplicating matters because the same list doubles as an
  // allow-list and reaches the model picker as configuration facts.
  const stringList = (value, fallback) => {
    if (!Array.isArray(value)) return [...fallback]
    const kept = [...new Set(value.filter(v => typeof v === 'string' && v.length > 0))]
    return kept.length > 0 ? kept : [...fallback]
  }
  // An empty list is a legitimate value for `baseURLs` (the default), so it
  // must not fall back to anything.
  const optionalList = (value) => (Array.isArray(value)
    ? [...new Set(value.filter(v => typeof v === 'string' && v.length > 0))]
    : [])
  let headers = stringList(c.headers, DEFAULT_HEADERS)
  if (headers.length === 0) headers = [...DEFAULT_HEADERS]
  const length = Number.isInteger(c.nanoidLength) && c.nanoidLength >= 4 && c.nanoidLength <= 32
    ? c.nanoidLength
    : 8
  return {
    enabled: c.enabled !== false,
    providers: stringList(c.providers, DEFAULT_PROVIDERS),
    hosts: stringList(c.hosts, DEFAULT_HOSTS),
    baseURLs: optionalList(c.baseURLs),
    headers: [...new Set(headers)].filter(h => HEADER_NAME_TOKEN.test(h)),
    /** Static extra request headers injected on matching opencode requests, e.g. opencode's fingerprint family: `{ "x-opencode-client": "native", "x-opencode-request": "dsh" }`. Headers only. */
    extraHeaders: headerPairs(c.extraHeaders),
    /** When set, override `User-Agent` on matching opencode requests (opencode itself sends `opencode/<version>`). Headers only; default leaves the platform UA untouched. */
    userAgent: typeof c.userAgent === 'string' ? c.userAgent.trim() : '',
    /** Environment variable name to fall back on for the session id. */
    sessionIdEnv: typeof c.sessionIdEnv === 'string' ? c.sessionIdEnv.trim() : '',
    verbose: c.verbose === true,
    /** When true, keep only the waterfall session scoping. */
    disableFetchInjection: c.disableFetchInjection === true,
    /** Opt-in only: fill a missing `options.sessionId` for the configured opencode routes (wire effect: headers only). Default off. */
    seedSessionId: c.seedSessionId === true,
    /**
     * Convert the dsh session id (`session-<uuid>`) to opencode-style nanoid(8)
     * via SHA-256 before putting it on the wire (`on` by default).
     * Deterministic per session — the gateway sees a stable opencode-format
     * token instead of the uuid. Set `false` to send the raw session id.
     */
    nanoidSessionId: c.nanoidSessionId !== false,
    /** Length of the derived nanoid token; opencode's web token is 8 chars. */
    nanoidLength: length,
    /** Token alphabet: `alphanumeric` (default, no `_`/`-`) or `urlsafe` (64-char nanoid with symbols). */
    nanoidAlphabet: NANOID_ALPHABETS[c.nanoidAlphabet] ? c.nanoidAlphabet : 'alphanumeric',
  }
}

/**
 * The value actually put on the wire for a raw session id.
 * @param raw - the dsh session id.
 * @param cfg - a normalized session configuration.
 */
export function wireSessionIdOf(raw, cfg) {
  if (!cfg.nanoidSessionId) return String(raw)
  return nanoidOf(stripSessionPrefix(raw), cfg.nanoidLength, NANOID_ALPHABETS[cfg.nanoidAlphabet])
}

/**
 * Per-request session scoping over AsyncLocalStorage. Every step of the
 * downstream LLM stream runs inside `run()`, so a fetch issued deep inside the
 * adapter — pi-ai fires its HTTP client synchronously from the stream's first
 * pull — observes the exact conversation session id even when several
 * conversations stream concurrently.
 */
export function createSessionScope() {
  const store = new AsyncLocalStorage()
  return {
    /** The session id active for the current async context, if any. */
    current() {
      return store.getStore()
    },
    run(sessionId, fn) {
      return store.run(String(sessionId), fn)
    },
  }
}

/**
 * Wrap a downstream LLM chunk stream to report every usage chunk it carries.
 *
 * The suite already intercepts `llm/stream` to scope session headers, so the
 * same pass can read what a request consumed without a second interception and
 * without touching the durable log. Chunks pass through untouched; the observer
 * sees `{type: 'usage'}` chunks only, and a throwing observer is swallowed so
 * accounting can never break a turn.
 * @param iterable - the downstream chunk stream.
 * @param onUsage - called with the chunk's `usage` object.
 * @returns an AsyncIterable with the same chunk semantics.
 */
export function observedIterable(iterable, onUsage) {
  const iterator = iterable[Symbol.asyncIterator]()
  const observe = value => {
    try {
      if (value && value.type === 'usage' && value.usage !== undefined) onUsage(value.usage)
    } catch {
      // Accounting must never break a turn.
    }
    return value
  }
  const pass = (method, args) => {
    const fn = iterator[method]
    if (typeof fn !== 'function') return undefined
    return Promise.resolve(fn.apply(iterator, args)).then(result => {
      if (result && result.done !== true) observe(result.value)
      return result
    })
  }
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      return pass('next', []) ?? Promise.resolve({ done: true, value: undefined })
    },
    return(...args) {
      return pass('return', args) ?? Promise.resolve({ done: true, value: undefined })
    },
    throw(...args) {
      return pass('throw', args) ?? Promise.resolve({ done: true, value: undefined })
    },
  }
}

/**
 * Wrap a downstream LLM chunk stream so each pull runs inside the scope,
 * keeping the session id visible to everything the adapter does on that pull.
 * @param scope - the session scope.
 * @param sessionId - the id to bind.
 * @param iterable - the downstream chunk stream (`next()` result).
 * @returns an AsyncIterable with the same chunk semantics.
 */
export function scopedIterable(scope, sessionId, iterable) {
  const iterator = iterable[Symbol.asyncIterator]()
  const inside = (method, args) => scope.run(sessionId, () => {
    const fn = iterator[method]
    return typeof fn === 'function' ? fn.apply(iterator, args) : undefined
  })
  const fallbackDone = Promise.resolve({ done: true, value: undefined })
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      return inside('next', []) ?? fallbackDone
    },
    return(...args) {
      return inside('return', args) ?? fallbackDone
    },
    throw(...args) {
      return inside('throw', args) ?? fallbackDone
    },
  }
}

/** Lowercase hostname of a URL, or '' when unreadable. */
export function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Does this request URL target a configured opencode endpoint? */
export function matchesTarget(url, hosts, baseURLs) {
  if (baseURLs.some(base => url.startsWith(base))) return true
  const host = hostnameOf(url)
  if (!host) return false
  return hosts.some(entry => {
    const suffix = entry.trim().toLowerCase().replace(/^\./, '')
    if (!suffix || suffix.includes('/')) return false
    return host === suffix || host.endsWith(`.${suffix}`)
  })
}

/**
 * Rebuild a fetch call with the session headers added, preserving every other
 * aspect (method, body, signal, duplex, credentials). Returns `null` when the
 * request cannot be rebuilt (e.g. a body-already-used Request), in which case
 * the caller passes the call through untouched.
 */
export function withSessionHeaders(input, init, headerNames, sessionId, extra = {}, userAgent = '') {
  const source = init?.headers
    ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
  const headers = new Headers(source ?? undefined)
  for (const headerName of headerNames) headers.set(headerName, String(sessionId))
  for (const [headerName, value] of Object.entries(extra)) headers.set(headerName, value)
  if (userAgent.length > 0) headers.set('user-agent', userAgent)
  if (typeof init === 'object' && init !== null) return { input, init: { ...init, headers } }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    try {
      return { input: new Request(input, { headers }), init: undefined }
    } catch {
      return null
    }
  }
  return { input, init: { headers } }
}

/**
 * A bounded record of the wire requests this plugin has actually tagged, so the
 * settings card can prove injection is live instead of asserting it. Newest
 * first; capped so a long session cannot grow it without bound.
 */
export class InjectionLog {
  /** @param {number} [limit] - entries to keep (default 20). */
  constructor(limit = 20) {
    this.limit = limit
    this.entries = []
  }

  /**
   * @param {object} entry
   * @param {string} entry.url
   * @param {string[]} entry.headers - `name: value` pairs actually set.
   * @param {string} entry.sessionId - the raw dsh session id.
   * @param {string} entry.token - the wire token.
   * @param {string} [entry.error] - set when the rebuild was skipped.
   */
  record(entry) {
    this.entries.unshift({
      at: new Date().toISOString(),
      url: entry.url,
      headers: [...entry.headers],
      sessionId: entry.sessionId,
      token: entry.token,
      // Always present, never absent: the Typert strict codec for this list
      // rejects a missing member, and "no error" is a fact worth stating.
      error: entry.error ?? null,
    })
    if (this.entries.length > this.limit) this.entries.length = this.limit
  }

  /** Detached newest-first copies. */
  list() {
    return this.entries.map(entry => ({ ...entry, headers: [...entry.headers] }))
  }

  clear() {
    this.entries.length = 0
  }
}

/**
 * Module-private bookkeeping key for an installed fetch wrapper. Each wrapper
 * records what it replaced and whether it has been disposed, so unwinding can
 * skip past wrappers that are already dead — restoring one would leave this
 * plugin's headers unreachable behind a defunct link.
 */
const WRAPPER_STATE = Symbol('dsh-opencode-suite.fetch-wrapper')

/**
 * Wrap `globalThis.fetch` so requests to opencode endpoints carry the
 * session-id headers. One wrapper per mount; disposal restores the previous
 * fetch unless another wrapper already took its place.
 *
 * The wrapper reads its configuration through `getConfig` on every call rather
 * than capturing it, so a settings edit (hosts, header list, `enabled`, …) takes
 * effect on the next request without reinstalling — reinstalling on every
 * settings change would mean stacking wrappers whenever a disposal was missed.
 *
 * @param {object} options
 * @param {() => object} options.getConfig - the live normalized session config.
 * @param {() => {sessionId: string, token: string}|undefined} options.getSession
 * @param {(message: string) => void} [options.log]
 * @param {InjectionLog} [options.injections]
 * @returns {() => void} the disposer.
 */
export function installSessionHeaderFetch({ getConfig, getSession, log, injections }) {
  const previous = globalThis.fetch
  if (typeof previous !== 'function') return () => {}
  const wrapped = (input, init) => {
    let nextInput = input
    let nextInit = init
    try {
      const cfg = getConfig()
      if (cfg.enabled && !cfg.disableFetchInjection && cfg.headers.length > 0) {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (typeof input === 'object' && input !== null && typeof input.url === 'string' ? input.url : '')
        if (url.length > 0 && matchesTarget(url, cfg.hosts, cfg.baseURLs)) {
          const session = getSession()
          if (session !== undefined && session !== null && String(session.sessionId).length > 0) {
            const merged = withSessionHeaders(
              input, init, cfg.headers, session.token, cfg.extraHeaders, cfg.userAgent,
            )
            if (merged !== null) {
              nextInput = merged.input
              nextInit = merged.init
              const set = [
                ...cfg.headers.map(h => `${h}: ${session.token}`),
                ...Object.entries(cfg.extraHeaders).map(([h, v]) => `${h}: ${v}`),
                ...(cfg.userAgent.length > 0 ? [`user-agent: ${cfg.userAgent}`] : []),
              ]
              injections?.record({ url, headers: set, sessionId: session.sessionId, token: session.token })
              log?.(`${url} ← ${set.join(', ')}`)
            } else {
              injections?.record({
                url,
                headers: [],
                sessionId: session.sessionId,
                token: session.token,
                error: 'request could not be rebuilt with extra headers; passed through untouched',
              })
            }
          }
        }
      }
    } catch (error) {
      log?.(`skipped header injection: ${error?.message ?? error}`)
    }
    return previous.call(globalThis, nextInput, nextInit)
  }
  const state = { disposed: false, previous }
  wrapped[WRAPPER_STATE] = state
  globalThis.fetch = wrapped
  return () => {
    state.disposed = true
    // Someone installed after us: leave their wrapper alone. Our own state is
    // already marked disposed, so when THEY unwind they will skip us too.
    if (globalThis.fetch !== wrapped) return
    let next = previous
    while (typeof next === 'function' && next[WRAPPER_STATE]?.disposed === true) {
      next = next[WRAPPER_STATE].previous
    }
    globalThis.fetch = next
  }
}

/**
 * Build the environment fallback resolver: `sessionIdEnv`, then the process's
 * startup `DSH_SESSION_ID`, then a per-process random uuid.
 * @param {string|(() => string)} sessionIdEnv - configured env variable name
 *   (may be empty), or a getter returning it so a settings edit applies live.
 * @returns {() => string}
 */
export function createEnvFallback(sessionIdEnv) {
  const envName = typeof sessionIdEnv === 'function' ? sessionIdEnv : () => sessionIdEnv
  let processId
  return () => {
    const configured = envName()
    if (typeof configured === 'string' && configured.length > 0
        && typeof process.env[configured] === 'string') {
      const hit = process.env[configured]
      if (hit.length > 0) return hit
    }
    if (typeof process.env.DSH_SESSION_ID === 'string' && process.env.DSH_SESSION_ID.length > 0) {
      return process.env.DSH_SESSION_ID
    }
    return processId ??= randomUUID()
  }
}
