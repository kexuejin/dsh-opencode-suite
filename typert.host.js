// Hand-written Typert host manifest for the opencodeSuite Remote.
// The typert-loader imports this via package.json exports["./typert"] and
// registers it into ctx.typert.local, which the Host gateway uses to claim and
// dispatch the "opencodeSuite/*" endpoints in strict mode.
//
// IMPORTANT: the typert-loader REQUIRES strict result codecs on EVERY
// invocation (src-json is rejected at manifest validation, which fails the
// whole plugin activation). Every result below is therefore a zod v4 schema;
// the business payload (status / freeTier / refreshModels) is strict-validated
// before it crosses the wire, and the simple mutation results ride as strict
// booleans/strings.
//
// Every result schema here must stay in lockstep with the corresponding method
// on OpenCodeSuite in index.js — an added optional field on the service side is
// fine (zod strips it), an added REQUIRED field is not (validation fails at
// runtime and the page shows the codec error).

import { z } from 'zod'

const usageWindowSchema = z.object({
  status: z.string().nullable(),
  percent: z.number().nullable(),
  resetsAt: z.string().nullable(),
})

const usageSchema = z.object({
  rolling: usageWindowSchema.nullable(),
  weekly: usageWindowSchema.nullable(),
  monthly: usageWindowSchema.nullable(),
})

const lastFailureSchema = z.object({
  code: z.string(),
  message: z.string(),
  at: z.string(),
})

const keyStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  apiKeyEnv: z.string(),
  state: z.string(),
  active: z.boolean(),
  usage: usageSchema.nullable(),
  usageError: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  credentialSet: z.boolean(),
  lastFailure: lastFailureSchema.nullable(),
})

const lastSwitchSchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  reason: z.string(),
  at: z.string(),
})

const availableModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  dynamic: z.boolean(),
  inputs: z.array(z.string()),
  catalogInputs: z.array(z.string()),
  contextWindow: z.number().nullable(),
  maxTokens: z.number().nullable(),
  capacitySource: z.string().nullable(),
})

const capacitySchema = z.object({
  contextWindow: z.number(),
  maxTokens: z.number(),
})

const configuredModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  contextWindow: z.number().nullable(),
  maxTokens: z.number().nullable(),
  input: z.array(z.string()),
})

const freeTierSchema = z.object({
  tier: z.string(),
  route: z.string(),
  baseURL: z.string(),
  exists: z.boolean(),
  apiKeyEnv: z.string().nullable(),
  configured: z.array(configuredModelSchema),
  live: z.array(z.string()),
  added: z.array(z.string()),
  stale: z.array(z.string()),
  revision: z.number().nullable(),
  error: z.string().nullable(),
})

const injectionSchema = z.object({
  at: z.string(),
  url: z.string(),
  headers: z.array(z.string()),
  sessionId: z.string(),
  token: z.string(),
  error: z.string().nullable(),
})

const sessionHeadersSchema = z.object({
  enabled: z.boolean(),
  providers: z.array(z.string()),
  hosts: z.array(z.string()),
  baseURLs: z.array(z.string()),
  headers: z.array(z.string()),
  extraHeaders: z.record(z.string(), z.string()),
  userAgent: z.string(),
  nanoidSessionId: z.boolean(),
  nanoidLength: z.number(),
  nanoidAlphabet: z.string(),
  seedSessionId: z.boolean(),
  verbose: z.boolean(),
  injected: z.number(),
  recent: z.array(injectionSchema),
})

// Local token accounting, folded from the session log by usage-log.js. Every
// counter is a plain non-negative integer sum; `share` is the row's fraction of
// its day (models inside a day) or of the window (the model list).
const usageCountersSchema = z.object({
  calls: z.number(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  total: z.number(),
})

const usageModelRowSchema = usageCountersSchema.extend({
  model: z.string(),
  share: z.number(),
})

const usageDaySchema = usageCountersSchema.extend({
  date: z.string(),
  models: z.array(usageModelRowSchema),
})

const usageBreakdownSchema = z.object({
  enabled: z.boolean(),
  source: z.union([z.literal('live'), z.literal('log')]),
  error: z.string().nullable(),
  updatedAt: z.string().nullable(),
  windowDays: z.number(),
  retentionDays: z.number(),
  sweep: z.object({
    sessions: z.number(),
    changed: z.number(),
    processed: z.number(),
    failed: z.number(),
    complete: z.boolean(),
    elapsedMs: z.number(),
  }),
  days: z.array(usageDaySchema),
  models: z.array(usageModelRowSchema),
  totals: usageCountersSchema.extend({ days: z.number() }),
})

const imTargetSchema = z.object({
  targetId: z.string(),
  name: z.string(),
  kind: z.string(),
})

const imBotSchema = z.object({
  botId: z.string(),
  channel: z.string(),
  targets: z.array(imTargetSchema),
})

const imTargetsSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  bots: z.array(imBotSchema),
})

const deliveryResultSchema = z.object({
  sent: z.boolean(),
  error: z.string().nullable(),
})

const modelNoticeSchema = z.object({
  id: z.string(),
  firstSeenAt: z.string(),
})

const modelWatchTierSchema = z.object({
  pending: z.array(modelNoticeSchema),
  gone: z.array(modelNoticeSchema),
  online: z.number(),
  onlineIds: z.array(z.string()),
  unconfigured: z.array(z.string()),
})

const modelWatchSchema = z.object({
  enabled: z.boolean(),
  seeded: z.boolean(),
  unconfiguredTotal: z.number(),
  intervalMs: z.number(),
  lastCheckedAt: z.string().nullable(),
  error: z.string().nullable(),
  pendingTotal: z.number(),
  tiers: z.object({
    go: modelWatchTierSchema,
    free: modelWatchTierSchema,
  }),
})

const suiteStatusSchema = z.object({
  takeover: z.string(),
  route: z.string(),
  usageRefreshMs: z.number(),
  preemptAtPercent: z.number(),
  switchAfterConsecutiveFailures: z.number(),
  modelMode: z.string(),
  availableModels: z.array(availableModelSchema),
  modelCapacities: z.record(z.string(), capacitySchema),
  activeId: z.string().nullable(),
  usableCount: z.number(),
  lastSwitch: lastSwitchSchema.nullable(),
  takeoverHint: z.string().nullable(),
  keys: z.array(keyStatusSchema),
  freeTier: freeTierSchema,
  modelWatch: modelWatchSchema,
  imNotify: z.object({
    enabled: z.boolean(),
    botId: z.string(),
    targetId: z.string(),
  }),
  sessionHeaders: sessionHeadersSchema,
})

const refreshModelsResultSchema = z.object({
  count: z.number(),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
  })),
  added: z.array(z.string()),
  fetchedAt: z.string(),
})

const freeTierWriteResultSchema = z.object({
  revision: z.number().nullable(),
  count: z.number(),
})

const keyInputSchema = z.object({
  id: z.string(),
  label: z.string(),
  apiKeyEnv: z.string(),
})

// A strict codec STRIPS keys it does not declare, so a field the card sends and
// this object does not list arrives at the service already gone — the card then
// fails with an empty patch. Every Config field a control can write belongs
// here; test/remote-convention.test.mjs fails when one is missing.
const configPatchSchema = z.object({
  // The ranges mirror the Config schema, so a card control is refused here with
  // the exact field named instead of travelling to the settings service first.
  preemptAtPercent: z.number().min(0).max(100).optional(),
  switchAfterConsecutiveFailures: z.number().min(0).max(20).optional(),
  modelMode: z.enum(['all', 'custom']).optional(),
  models: z.array(z.string()).optional(),
  imageModels: z.array(z.string()).optional(),
  modelCapacities: z.record(z.string(), capacitySchema).optional(),
  usageLogEnabled: z.boolean().optional(),
  usageLogSource: z.enum(['live', 'log']).optional(),
  usageLogWindowDays: z.number().int().min(1).max(365).optional(),
  usageLogRetentionDays: z.number().int().min(1).max(3650).optional(),
  usageLogSessionsPerSweep: z.number().int().min(1).max(5000).optional(),
  usageLogSweepMaxMs: z.number().int().min(200).max(120000).optional(),
  modelWatchEnabled: z.boolean().optional(),
  modelWatchIntervalMs: z.number().int().min(300000).max(86400000).optional(),
  notifyImEnabled: z.boolean().optional(),
  notifyImBotId: z.string().optional(),
  notifyImTargetId: z.string().optional(),
})

const sessionHeadersPatchSchema = z.object({
  enabled: z.boolean().optional(),
  verbose: z.boolean().optional(),
  seedSessionId: z.boolean().optional(),
  nanoidSessionId: z.boolean().optional(),
  disableFetchInjection: z.boolean().optional(),
  nanoidLength: z.number().optional(),
  nanoidAlphabet: z.string().optional(),
  providers: z.array(z.string()).optional(),
  hosts: z.array(z.string()).optional(),
  baseURLs: z.array(z.string()).optional(),
  headers: z.array(z.string()).optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  userAgent: z.string().optional(),
})

const freeTierEntrySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
  input: z.array(z.string()).optional(),
  reasoningEfforts: z.union([
    z.literal(false),
    z.record(z.string(), z.string().nullable()),
  ]).optional(),
})

// The loader's 0.1.7 contract: a strict codec carries a `create()` FACTORY that
// materializes the schema on first boundary use, not the schema instance itself.
// A codec without `create` fails manifest validation, which fails the whole
// plugin activation (every /api/opencodeSuite/* route answers 404).
const strict = (typeSymbol, schema) => ({ mode: 'strict', typeSymbol, create: () => schema })

// Every other descriptor field has to be named here: a parameter that omits a
// field the gateway reads (such as `acceptsUndefined`, which is what makes an
// optional field omissible) would otherwise be dropped on the floor, and the
// symptom is a gateway error about a field nobody sent.
const invocation = (method, parameters, result) => ({
  id: `dsh-opencode-suite#opencodeSuite/${method}`,
  service: 'opencodeSuite',
  namespace: 'opencodeSuite',
  method,
  invocation: { kind: 'direct' },
  parameters: parameters.map(({ name, wire, typeSymbol, schema, acceptsUndefined }) => ({
    name,
    wire,
    source: 'json',
    codec: strict(typeSymbol, schema),
    ...(acceptsUndefined === undefined ? {} : { acceptsUndefined }),
  })),
  result,
})

export const TYPERT = {
  package: 'dsh-opencode-suite',
  face: 'host',
  schemas: [],
  invocations: [
    invocation('status', [], strict('dsh-opencode-suite#SuiteStatus', suiteStatusSchema)),
    invocation('usageBreakdown', [
      {
        name: 'days',
        wire: 'days',
        typeSymbol: 'dsh-opencode-suite#UsageWindowDays',
        schema: z.number().int().min(1).max(365).optional(),
        // The window is optional on the service too (it falls back to the
        // configured one), so a caller may leave the field out entirely. The
        // gateway rejects an omitted field unless the descriptor says so.
        acceptsUndefined: true,
      },
    ], strict('dsh-opencode-suite#UsageBreakdown', usageBreakdownSchema)),
    invocation('imTargets', [], strict('dsh-opencode-suite#ImTargets', imTargetsSchema)),
    invocation('testImNotify', [
      {
        name: 'text',
        wire: 'text',
        typeSymbol: 'dsh-opencode-suite#ImTestText',
        schema: z.string().optional(),
        acceptsUndefined: true,
      },
    ], strict('dsh-opencode-suite#DeliveryResult', deliveryResultSchema)),
    invocation('checkModels', [], strict('dsh-opencode-suite#ModelCheckResult', z.object({
      notices: z.array(z.string()),
      pendingTotal: z.number(),
    }))),
    invocation('dismissModelNews', [
      {
        name: 'tier',
        wire: 'tier',
        typeSymbol: 'dsh-opencode-suite#WatchedTier',
        schema: z.union([z.literal('go'), z.literal('free')]),
      },
    ], strict('number', z.number())),
    invocation('takeOverState', [], strict('string', z.string())),
    invocation('setActive', [
      { name: 'id', wire: 'id', typeSymbol: 'string', schema: z.string() },
    ], strict('boolean', z.boolean())),
    invocation('setDisabled', [
      { name: 'id', wire: 'id', typeSymbol: 'string', schema: z.string() },
      { name: 'on', wire: 'on', typeSymbol: 'boolean', schema: z.boolean() },
    ], strict('boolean', z.boolean())),
    invocation('clearInvalid', [
      { name: 'id', wire: 'id', typeSymbol: 'string', schema: z.string() },
    ], strict('boolean', z.boolean())),
    invocation('clearExhausted', [
      { name: 'id', wire: 'id', typeSymbol: 'string', schema: z.string() },
    ], strict('boolean', z.boolean())),
    invocation('putKeys', [
      {
        name: 'keys',
        wire: 'keys',
        typeSymbol: 'dsh-opencode-suite#KeyInputList',
        schema: z.array(keyInputSchema),
      },
    ], strict('boolean', z.boolean())),
    invocation('putKeySecret', [
      { name: 'id', wire: 'id', typeSymbol: 'string', schema: z.string() },
      { name: 'secret', wire: 'secret', typeSymbol: 'string', schema: z.string() },
    ], strict('boolean', z.boolean())),
    invocation('putConfig', [
      { name: 'config', wire: 'config', typeSymbol: 'dsh-opencode-suite#ConfigPatch', schema: configPatchSchema },
    ], strict('boolean', z.boolean())),
    invocation('putSessionHeaders', [
      {
        name: 'patch',
        wire: 'patch',
        typeSymbol: 'dsh-opencode-suite#SessionHeadersPatch',
        schema: sessionHeadersPatchSchema,
      },
    ], strict('boolean', z.boolean())),
    invocation('clearSessionLog', [], strict('boolean', z.boolean())),
    invocation('refreshModels', [], strict('dsh-opencode-suite#RefreshModelsResult', refreshModelsResultSchema)),
    invocation('freeTier', [], strict('dsh-opencode-suite#FreeTierStatus', freeTierSchema)),
    invocation('putFreeTierModels', [
      {
        name: 'entries',
        wire: 'entries',
        typeSymbol: 'dsh-opencode-suite#FreeTierEntryList',
        schema: z.array(freeTierEntrySchema),
      },
      { name: 'assumeDefaults', wire: 'assumeDefaults', typeSymbol: 'boolean', schema: z.boolean() },
    ], strict('dsh-opencode-suite#FreeTierWriteResult', freeTierWriteResultSchema)),
  ],
  model: { services: [], events: [], objects: [] },
}
