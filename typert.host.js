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

const configPatchSchema = z.object({
  preemptAtPercent: z.number().optional(),
  switchAfterConsecutiveFailures: z.number().optional(),
  modelMode: z.string().optional(),
  models: z.array(z.string()).optional(),
  imageModels: z.array(z.string()).optional(),
  modelCapacities: z.record(z.string(), capacitySchema).optional(),
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

const strict = (typeSymbol, schema) => ({ mode: 'strict', typeSymbol, schema })

const invocation = (method, parameters, result) => ({
  id: `dsh-opencode-suite#opencodeSuite/${method}`,
  service: 'opencodeSuite',
  namespace: 'opencodeSuite',
  method,
  invocation: { kind: 'direct' },
  parameters: parameters.map(({ name, wire, typeSymbol, schema }) => ({
    name, wire, source: 'json', codec: strict(typeSymbol, schema),
  })),
  result,
})

export const TYPERT = {
  package: 'dsh-opencode-suite',
  face: 'host',
  schemas: [],
  invocations: [
    invocation('status', [], strict('dsh-opencode-suite#SuiteStatus', suiteStatusSchema)),
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
