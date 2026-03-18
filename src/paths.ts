import { homedir } from 'os';
import { join } from 'path';

export const CLAUDE_DIR = join(homedir(), '.claude');
export const CLAUDE_SETTINGS = join(CLAUDE_DIR, 'settings.json');
export const CLAUDE_MD = join(CLAUDE_DIR, 'CLAUDE.md');
export const CLAUDE_AGENTS_DIR = join(CLAUDE_DIR, 'agents');
export const CLAUDE_SKILLS_DIR = join(CLAUDE_DIR, 'skills');
export const CLAUDE_PLUGINS_DIR = join(CLAUDE_DIR, 'plugins');
export const CLAUDE_TEAMS_DIR = join(CLAUDE_DIR, 'teams');

export const CC_SWITCH_DIR = join(homedir(), '.cc-switch');
export const PROFILES_DIR = join(CC_SWITCH_DIR, 'profiles');
export const STATE_FILE = join(CC_SWITCH_DIR, 'state.json');

export const AVAILABLE_MANAGED_PATHS = [
  { name: 'CLAUDE.md', label: 'Instructions (CLAUDE.md)', claudePath: CLAUDE_MD },
  { name: 'agents', label: 'Agents', claudePath: CLAUDE_AGENTS_DIR },
  { name: 'skills', label: 'Skills', claudePath: CLAUDE_SKILLS_DIR },
  { name: 'plugins', label: 'Plugins', claudePath: CLAUDE_PLUGINS_DIR },
  { name: 'teams', label: 'Teams', claudePath: CLAUDE_TEAMS_DIR },
] as const;

export const DEFAULT_MANAGED_PATHS = ['CLAUDE.md', 'agents', 'skills'];

export function getProfileDir(profileName: string): string {
  return join(PROFILES_DIR, profileName);
}

export function getProfileSettings(profileName: string): string {
  return join(getProfileDir(profileName), 'settings.json');
}

export function getProfileMetaPath(profileName: string): string {
  return join(getProfileDir(profileName), 'profile.json');
}

export function getProfileManagedPath(profileName: string, managedName: string): string {
  const valid = AVAILABLE_MANAGED_PATHS.some(p => p.name === managedName);
  if (!valid) {
    throw new Error(`Invalid managed path name: "${managedName}"`);
  }
  return join(getProfileDir(profileName), managedName);
}
