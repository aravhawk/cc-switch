export interface State {
  activeProfile: string;
  lastSyncedAt: string;
}

export type ProfileType = 'settings' | 'full';

export interface ProfileMeta {
  type: ProfileType;
  version: number;
  managedPaths: string[];
}

export interface ProfileInfo {
  name: string;
  isActive: boolean;
  type: ProfileType;
  /** Settings summary derived from the profile's settings.json (live file for the active profile) */
  summary: SettingsSummary;
}

export interface ActiveProfileStatus {
  name: string;
  exists: boolean;
}

/** Credentials and routing derived from a settings.json `env` block. Never contains the raw key. */
export interface SettingsSummary {
  /** Matching provider template id, if the base URL belongs to a known provider */
  providerId?: string;
  providerLabel?: string;
  /** Matching endpoint variant of the provider, if any */
  endpointId?: string;
  baseUrl?: string;
  models: {
    main?: string;
    opus?: string;
    sonnet?: string;
    haiku?: string;
    fable?: string;
    subagent?: string;
  };
  /** Which credential variable is set, if any */
  credential?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  /** Masked credential suitable for display */
  maskedKey?: string;
  /** True when settings.json could not be read or parsed */
  unreadable?: boolean;
}

export interface CreateProfileOptions {
  /** Provider template id (or alias) */
  template?: string;
  /** Endpoint variant of the template (e.g. a regional endpoint) */
  endpoint?: string;
  apiKey?: string;
  /** Base URL for a custom provider or to override a template */
  baseUrl?: string;
  /** Model overrides. `model` applies to every tier. */
  models?: ModelOverrides;
  /** Credential variable for custom providers */
  authStyle?: 'token' | 'api-key';
  /** Extra env entries, for provider fields (cloud region/project) or --env NAME=VALUE */
  env?: Record<string, string>;
  full?: boolean;
  managedPaths?: string[];
}

export interface ModelOverrides {
  model?: string;
  opus?: string;
  sonnet?: string;
  haiku?: string;
  fable?: string;
  subagent?: string;
}
