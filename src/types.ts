export interface State {
  activeProfile: string;
  lastSyncedAt: string;
}

export interface ProfileInfo {
  name: string;
  isActive: boolean;
}

export interface ActiveProfileStatus {
  name: string;
  exists: boolean;
}

export type ProviderTemplateName = 'anthropic' | 'moonshot' | 'zai' | 'minimax';

export interface CreateProfileOptions {
  template?: ProviderTemplateName;
  apiKey?: string;
}
