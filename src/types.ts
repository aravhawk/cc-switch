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
}

export interface ActiveProfileStatus {
  name: string;
  exists: boolean;
}

export type ProviderTemplateName = 'anthropic' | 'moonshot' | 'zai' | 'minimax';

export interface CreateProfileOptions {
  template?: ProviderTemplateName;
  apiKey?: string;
  full?: boolean;
  managedPaths?: string[];
}
