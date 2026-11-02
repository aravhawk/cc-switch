import { validateBaseUrl } from '../connection-test.js';
import type { ModelOverrides } from '../types.js';
import { PROVIDER_CATALOG } from './catalog.js';
import type {
  ModelSet,
  Provider,
  ProviderApplication,
  ProviderCategory,
  ProviderEndpoint,
} from './types.js';

export { PROVIDER_CATEGORY_LABELS } from './types.js';
export type { Provider, ProviderEndpoint, ProviderCategory, ModelSet } from './types.js';

/** Any Anthropic-compatible endpoint: self-hosted gateways, proxies, or providers not in the catalog. */
const CUSTOM_PROVIDER: Provider = {
  id: 'custom',
  label: 'Custom endpoint',
  description: 'Any Anthropic Messages-compatible URL (LiteLLM, a corporate proxy, a new provider)',
  category: 'gateway',
  aliases: ['other', 'proxy'],
  auth: 'token',
  keyOptional: true,
  endpoints: [],
  docsUrl: 'https://code.claude.com/docs/en/llm-gateway',
  notes: ['The endpoint must implement the Anthropic Messages API (POST /v1/messages).'],
};

export const PROVIDERS: readonly Provider[] = [...PROVIDER_CATALOG, CUSTOM_PROVIDER];

const PROVIDER_INDEX = new Map<string, Provider>();
for (const provider of PROVIDERS) {
  PROVIDER_INDEX.set(provider.id.toLowerCase(), provider);
  for (const alias of provider.aliases ?? []) {
    PROVIDER_INDEX.set(alias.toLowerCase(), provider);
  }
}

export function findProvider(input: string | undefined): Provider | undefined {
  if (!input) return undefined;
  return PROVIDER_INDEX.get(input.trim().toLowerCase());
}

export function listProviders(category?: ProviderCategory): Provider[] {
  return PROVIDERS.filter(provider => !category || provider.category === category);
}

export function providerNeedsKey(provider: Provider): boolean {
  return provider.auth === 'token' || provider.auth === 'api-key' || provider.auth === 'both';
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

export interface DetectedProvider {
  provider: Provider;
  endpoint?: ProviderEndpoint;
}

/** Identify which built-in provider a settings.json `env` block points at. */
/** Claude Code treats "", "0" and "false" as off for its CLAUDE_CODE_USE_* switches. */
function isOn(value: string | undefined): boolean {
  return Boolean(value) && !['0', 'false', 'no', 'off'].includes(value!.trim().toLowerCase());
}

export function detectProvider(env: Record<string, string>): DetectedProvider | undefined {
  if (isOn(env.CLAUDE_CODE_USE_BEDROCK) || isOn(env.CLAUDE_CODE_USE_MANTLE)) {
    const bedrock = PROVIDER_INDEX.get('bedrock');
    const endpointId = isOn(env.CLAUDE_CODE_USE_MANTLE) ? 'mantle' : 'invoke';
    return bedrock ? { provider: bedrock, endpoint: bedrock.endpoints.find(e => e.id === endpointId) } : undefined;
  }
  if (isOn(env.CLAUDE_CODE_USE_ANTHROPIC_AWS)) return withId('anthropic-aws');
  if (isOn(env.CLAUDE_CODE_USE_VERTEX)) return withId('vertex');
  if (isOn(env.CLAUDE_CODE_USE_FOUNDRY)) return withId('foundry');

  const baseUrl = env.ANTHROPIC_BASE_URL;
  if (!baseUrl) return withId('anthropic');

  const wanted = normalizeUrl(baseUrl);
  for (const provider of PROVIDERS) {
    for (const endpoint of provider.endpoints) {
      if (normalizeUrl(endpoint.baseUrl) === wanted) return { provider, endpoint };
    }
  }
  return undefined;
}

function withId(id: string): DetectedProvider | undefined {
  const provider = PROVIDER_INDEX.get(id);
  return provider ? { provider } : undefined;
}

/** True when the provider ships recommended model defaults (as opposed to "you choose the model"). */
export function hasRecommendedModels(provider: Provider): boolean {
  const hasModels = (models: ModelSet | undefined) => Boolean(models && Object.values(models).some(Boolean));
  return hasModels(provider.models) || provider.endpoints.some(endpoint => hasModels(endpoint.models));
}

export interface SelectionInput {
  template: string;
  endpoint?: string;
  baseUrl?: string;
  models?: ModelOverrides;
  authStyle?: 'token' | 'api-key';
  /** Extra env entries (provider fields such as AWS_REGION, or --env NAME=VALUE) */
  env?: Record<string, string>;
}

export interface Selection {
  provider: Provider;
  endpoint?: ProviderEndpoint;
  application: ProviderApplication;
}

function mergeModels(base: ModelSet, overrides: ModelOverrides | undefined): ModelSet {
  const models: ModelSet = { ...base };
  if (!overrides) return models;

  if (overrides.model) {
    // A single model for everything: also pin the subagent model so it cannot fall back to another one.
    models.main = overrides.model;
    models.opus = overrides.model;
    models.sonnet = overrides.model;
    models.haiku = overrides.model;
    models.fable = overrides.model;
    models.subagent = overrides.model;
  }
  if (overrides.opus) models.opus = overrides.opus;
  if (overrides.sonnet) models.sonnet = overrides.sonnet;
  // ANTHROPIC_MODEL pins the main session; if the provider set it, it must follow the tier the user chose.
  if (!overrides.model && base.main && (overrides.sonnet || overrides.opus)) {
    models.main = overrides.sonnet ?? overrides.opus;
  }
  if (overrides.haiku) models.haiku = overrides.haiku;
  if (overrides.fable) models.fable = overrides.fable;
  if (overrides.subagent) models.subagent = overrides.subagent;
  return models;
}

/**
 * --env cannot carry the endpoint or a credential: those have validated paths (--base-url,
 * key options) and a key in argv would defeat the safer key inputs.
 */
const RESERVED_ENV_NAMES = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_FOUNDRY_API_KEY',
  '__proto__',
  'constructor',
  'prototype',
]);

function cleanExtraEnv(env: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (RESERVED_ENV_NAMES.has(name)) {
      throw new Error(
        name.startsWith('ANTHROPIC_') && name !== 'ANTHROPIC_BASE_URL'
          ? `${name} cannot be set with --env. Use --api-key-env or --api-key-stdin for keys.`
          : name === 'ANTHROPIC_BASE_URL'
            ? '--env cannot set ANTHROPIC_BASE_URL. Use --base-url.'
            : `"${name}" is not a valid environment variable name here`
      );
    }
    const trimmed = value.trim();
    if (trimmed) result[name] = trimmed;
  }
  return result;
}

export function resolveSelection(input: SelectionInput): Selection {
  const provider = findProvider(input.template);
  if (!provider) {
    throw new Error(`Unknown provider "${input.template}". Run "cc-switch --providers" to list the available providers.`);
  }

  if (input.authStyle && provider.id !== 'custom') {
    throw new Error('--auth-style only applies to the "custom" template; other providers define their own credential variable.');
  }
  const extraEnv = cleanExtraEnv(input.env);

  let endpoint: ProviderEndpoint | undefined;
  if (input.endpoint) {
    endpoint = provider.endpoints.find(e => e.id.toLowerCase() === input.endpoint!.trim().toLowerCase());
    if (!endpoint) {
      const available = provider.endpoints.map(e => e.id).join(', ');
      throw new Error(
        provider.endpoints.length > 0
          ? `Provider "${provider.id}" has no endpoint "${input.endpoint}". Available endpoints: ${available}`
          : `Provider "${provider.id}" has no selectable endpoints; use --base-url`
      );
    }
  } else {
    endpoint = provider.endpoints[0];
  }

  const baseUrl = input.baseUrl?.trim() || endpoint?.baseUrl;
  if (provider.auth !== 'native' && !baseUrl) {
    throw new Error(`Provider "${provider.id}" needs a base URL. Pass --base-url <url>.`);
  }
  if (baseUrl) {
    const problem = validateBaseUrl(baseUrl);
    if (problem) throw new Error(problem);
  }

  const models = mergeModels(endpoint?.models ?? provider.models ?? {}, input.models);

  if (provider.requiresModel) {
    const hasModel = models.main || models.opus || models.sonnet || models.haiku;
    if (!hasModel) {
      const example = provider.modelExample ? ` (for example ${provider.modelExample})` : '';
      throw new Error(`Provider "${provider.id}" hosts many models. Choose one with --model <id>${example}.`);
    }
  }

  // Keep the "fable" alias on a model the endpoint can serve; otherwise it would resolve to a Claude ID.
  if (baseUrl && provider.auth !== 'native' && !models.fable) {
    models.fable = models.opus ?? models.main ?? models.sonnet;
  }

  for (const field of provider.fields ?? []) {
    const supplied = extraEnv[field.env];
    if (!supplied && field.defaultValue === undefined && field.required && !(provider.env?.[field.env] ?? endpoint?.env?.[field.env])) {
      throw new Error(`Provider "${provider.id}" needs ${field.label} (${field.env}). Pass --env ${field.env}=<value>.`);
    }
  }
  const fieldDefaults: Record<string, string> = {};
  for (const field of provider.fields ?? []) {
    if (field.defaultValue !== undefined && !extraEnv[field.env]) fieldDefaults[field.env] = field.defaultValue;
  }

  const auth = provider.id === 'custom' ? (input.authStyle ?? provider.auth) : provider.auth;

  return {
    provider,
    endpoint,
    application: {
      baseUrl: provider.auth === 'native' ? undefined : baseUrl,
      auth,
      placeholderToken: provider.placeholderToken,
      models,
      env: { ...provider.env, ...endpoint?.env, ...fieldDefaults, ...extraEnv },
    },
  };
}
