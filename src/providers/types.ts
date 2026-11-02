/**
 * How the provider expects the credential to be sent.
 * - token:   ANTHROPIC_AUTH_TOKEN (Authorization: Bearer ...)
 * - api-key: ANTHROPIC_API_KEY (x-api-key header)
 * - both:    the key is written to both variables (Hugging Face documents this)
 * - none:    local server, no real credential needed (a placeholder token is written)
 * - native:  Claude Code talks to the platform itself (Anthropic, Bedrock, Vertex, Foundry); no base URL or token
 */
export type AuthStyle = 'token' | 'api-key' | 'both' | 'none' | 'native';

export type ProviderCategory =
  | 'anthropic'
  | 'lab' // first-party model lab APIs and coding plans
  | 'gateway' // routers and aggregators
  | 'host' // open-model inference hosts
  | 'local' // runs on your machine
  | 'cloud'; // hyperscaler platforms

export const PROVIDER_CATEGORY_LABELS: Record<ProviderCategory, string> = {
  anthropic: 'Anthropic',
  lab: 'Model labs',
  local: 'Local',
  gateway: 'Gateways and routers',
  host: 'Inference hosts',
  cloud: 'Cloud platforms',
};

/** Model IDs for each Claude Code tier. Omitted tiers are left to Claude Code's defaults. */
export interface ModelSet {
  /** ANTHROPIC_MODEL: the model used for the main session */
  main?: string;
  opus?: string;
  sonnet?: string;
  haiku?: string;
  /** ANTHROPIC_DEFAULT_FABLE_MODEL */
  fable?: string;
  /** CLAUDE_CODE_SUBAGENT_MODEL */
  subagent?: string;
}

export interface ProviderEndpoint {
  /** Short identifier used with --endpoint */
  id: string;
  label: string;
  /** Value for ANTHROPIC_BASE_URL */
  baseUrl: string;
  /** Replaces the provider's models for this endpoint */
  models?: ModelSet;
  /** Merged over the provider's env for this endpoint */
  env?: Record<string, string>;
  /** Where to create an API key for this endpoint */
  keyUrl?: string;
  /** One-line hint shown in pickers */
  hint?: string;
}

/** A value the user supplies for providers that need more than a key (cloud region, project, resource...). */
export interface ProviderField {
  /** settings.json env variable the value is written to */
  env: string;
  label: string;
  placeholder?: string;
  required: boolean;
  /** Prefilled value when the user does not provide one */
  defaultValue?: string;
}

export interface Provider {
  /** Stable identifier used with --template */
  id: string;
  label: string;
  description: string;
  category: ProviderCategory;
  aliases?: string[];
  auth: AuthStyle;
  /** The first endpoint is the default. */
  endpoints: ProviderEndpoint[];
  /** Default model mapping for every endpoint (endpoints may replace it). */
  models?: ModelSet;
  /** Values to collect from the user and write to env (cloud platforms). */
  fields?: ProviderField[];
  /** Extra settings.json env entries (timeouts, context windows, compatibility flags). */
  env?: Record<string, string>;
  /**
   * The provider hosts many models and has no sensible default mapping:
   * the user must supply one (--model) and the picker asks for it.
   */
  requiresModel?: boolean;
  /** The endpoint works without a key (self-hosted gateways); the key prompt may be left empty. */
  keyOptional?: boolean;
  /** Dummy credential written for local servers that ignore auth but require the variable. */
  placeholderToken?: string;
  /** Example model ID shown as a hint when `requiresModel` is set. */
  modelExample?: string;
  docsUrl: string;
  keyUrl?: string;
  /** Short caveats surfaced after creation. */
  notes?: string[];
}

/** Fully resolved settings to write for a provider (everything except the secret itself). */
export interface ProviderApplication {
  baseUrl?: string;
  auth: AuthStyle;
  apiKey?: string;
  /** Placeholder token written for auth: 'none' providers (local servers) */
  placeholderToken?: string;
  models: ModelSet;
  env: Record<string, string>;
}
