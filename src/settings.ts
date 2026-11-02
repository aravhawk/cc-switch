import type { SettingsSummary } from './types.js';
import type { ModelSet, ProviderApplication } from './providers/types.js';
import { detectProvider } from './providers/index.js';

type SettingsObject = Record<string, unknown>;

/**
 * settings.json `env` keys that identify or depend on a specific provider or model. Applying a
 * provider always clears these, so a base URL, token, model mapping or window size from the
 * previous provider can never leak into the new one.
 */
export const PROVIDER_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
  // Sized or tuned for one model
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_DISABLE_THINKING',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  // Cloud platform switches, endpoints and credentials
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_BEDROCK_REGION_PREFIX',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
];

/**
 * Keys that belong to the user, not to a provider. Templates may set them (for example the
 * Z.ai template turns off non-essential traffic), but they are never removed again: a privacy
 * opt-out must not disappear because you switched providers.
 */
export const USER_OWNED_ENV_KEYS: readonly string[] = ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];

/**
 * Other keys a template sets (timeouts, headers, region/project fields) are removed only when the
 * provider currently configured in the settings set them itself, so values you added yourself survive.
 */
function keysSetByCurrentProvider(env: Record<string, string>): string[] {
  const detected = detectProvider(env);
  if (!detected) return [];
  const { provider, endpoint } = detected;
  const keys = [
    ...Object.keys(provider.env ?? {}),
    ...Object.keys(endpoint?.env ?? {}),
    ...(provider.fields ?? []).map(field => field.env),
  ];
  return keys.filter(key => !USER_OWNED_ENV_KEYS.includes(key));
}

/** Values accepted by Claude Code's top-level `model` setting that are safe on any backend. */
const PORTABLE_MODEL_ALIASES = /^(default|best|fable|opus|sonnet|haiku|opusplan|inherit)(\[1m\])?$/i;

export function parseSettings(text: string, source = 'settings.json'): SettingsObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Do not echo error.message: on some Node versions it quotes a snippet of the file, which may hold a key.
    const position = error instanceof Error ? /position (\d+)/.exec(error.message)?.[1] : undefined;
    throw new Error(`${source} is not valid JSON${position ? ` (near character ${position})` : ''}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  return parsed as SettingsObject;
}

export function serializeSettings(settings: SettingsObject): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function getEnv(settings: SettingsObject): Record<string, string> {
  const env = settings.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') result[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') result[key] = String(value);
  }
  return result;
}

/**
 * Return a copy of `settings` configured for a provider. Pure: does not touch the filesystem.
 */
export function applyProvider(settings: SettingsObject, application: ProviderApplication): SettingsObject {
  const result: SettingsObject = { ...settings };
  const rawEnv = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
    ? { ...(settings.env as Record<string, unknown>) }
    : {};

  const stringEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) if (typeof value === 'string') stringEnv[key] = value;
  for (const key of [...PROVIDER_ENV_KEYS, ...keysSetByCurrentProvider(stringEnv)]) delete rawEnv[key];

  const env: Record<string, unknown> = rawEnv;

  if (application.baseUrl) env.ANTHROPIC_BASE_URL = application.baseUrl;

  if (application.auth === 'token' && application.apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = application.apiKey;
  } else if (application.auth === 'api-key' && application.apiKey) {
    env.ANTHROPIC_API_KEY = application.apiKey;
  } else if (application.auth === 'both' && application.apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = application.apiKey;
    env.ANTHROPIC_API_KEY = application.apiKey;
  } else if (application.auth === 'none' && application.placeholderToken) {
    env.ANTHROPIC_AUTH_TOKEN = application.placeholderToken;
  }

  const { models } = application;
  if (models.main) env.ANTHROPIC_MODEL = models.main;
  if (models.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = models.opus;
  if (models.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = models.sonnet;
  if (models.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = models.haiku;
  if (models.fable) env.ANTHROPIC_DEFAULT_FABLE_MODEL = models.fable;
  if (models.subagent) env.CLAUDE_CODE_SUBAGENT_MODEL = models.subagent;

  Object.assign(env, application.env);

  // A pinned Claude model ID in the top-level `model` setting would be sent to the new backend
  // and rejected. Aliases such as "opus" are kept: they resolve through the mapping above.
  if (application.auth !== 'native' && application.baseUrl) {
    if (typeof result.model === 'string' && !PORTABLE_MODEL_ALIASES.test(result.model.trim())) {
      delete result.model;
    }
  }

  if (Object.keys(env).length > 0) result.env = env;
  else delete result.env;

  return result;
}

/** Return a copy of `settings` with every provider-managed env key removed (back to Claude Code defaults). */
export function clearProvider(settings: SettingsObject): SettingsObject {
  return applyProvider(settings, { auth: 'native', models: {}, env: {} });
}

/** Update only the credential of already-configured settings. */
export function replaceCredential(
  settings: SettingsObject,
  apiKey: string
): { settings: SettingsObject; variable: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY' } {
  const env = getEnv(settings);
  // Keep whichever variable(s) the profile already uses; default to the bearer token.
  const hasToken = Boolean(env.ANTHROPIC_AUTH_TOKEN);
  const hasApiKey = Boolean(env.ANTHROPIC_API_KEY);
  const variable = hasApiKey && !hasToken ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
  const updates: Record<string, string> = { [variable]: apiKey };
  // Providers such as Hugging Face need the same key in both variables.
  if (hasToken && hasApiKey && env.ANTHROPIC_API_KEY === env.ANTHROPIC_AUTH_TOKEN) {
    updates.ANTHROPIC_API_KEY = apiKey;
  }
  return {
    settings: { ...settings, env: { ...(settings.env as Record<string, unknown> | undefined), ...updates } },
    variable,
  };
}

/** Update only model entries of already-configured settings. */
export function replaceModels(settings: SettingsObject, models: ModelSet): SettingsObject {
  const env: Record<string, unknown> = {
    ...((settings.env && typeof settings.env === 'object' ? settings.env : {}) as Record<string, unknown>),
  };
  const mapping: Array<[keyof ModelSet, string]> = [
    ['main', 'ANTHROPIC_MODEL'],
    ['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
    ['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
    ['haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
    ['fable', 'ANTHROPIC_DEFAULT_FABLE_MODEL'],
    ['subagent', 'CLAUDE_CODE_SUBAGENT_MODEL'],
  ];
  for (const [tier, key] of mapping) {
    const value = models[tier];
    if (value) env[key] = value;
  }
  return { ...settings, env };
}

export function maskSecret(secret: string | undefined): string | undefined {
  if (!secret) return undefined;
  const value = secret.trim();
  if (value.length < 12) return '*'.repeat(Math.max(value.length, 4));
  // Short keys: tail only. Long keys: the vendor prefix (sk-...) and the tail.
  if (value.length < 20) return `...${value.slice(-4)}`;
  return `${value.slice(0, 3)}...${value.slice(-4)}`;
}

export function summarizeSettings(settings: SettingsObject): SettingsSummary {
  const env = getEnv(settings);
  const baseUrl = env.ANTHROPIC_BASE_URL || undefined;
  const credential = env.ANTHROPIC_AUTH_TOKEN
    ? 'ANTHROPIC_AUTH_TOKEN'
    : env.ANTHROPIC_API_KEY
      ? 'ANTHROPIC_API_KEY'
      : undefined;
  const secret = credential ? env[credential] : undefined;

  const detected = detectProvider(env);

  return {
    providerId: detected?.provider.id,
    providerLabel: detected?.provider.label,
    endpointId: detected?.endpoint?.id,
    baseUrl,
    models: {
      main: env.ANTHROPIC_MODEL || undefined,
      opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || undefined,
      sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || undefined,
      haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || undefined,
      fable: env.ANTHROPIC_DEFAULT_FABLE_MODEL || undefined,
      subagent: env.CLAUDE_CODE_SUBAGENT_MODEL || undefined,
    },
    credential,
    maskedKey: maskSecret(secret),
  };
}

/** Raw env access for callers that need to read the full credential (connection tests). */
export function readEnv(settings: SettingsObject): Record<string, string> {
  return getEnv(settings);
}
