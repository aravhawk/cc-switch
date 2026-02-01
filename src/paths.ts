import { homedir } from 'os';
import { join } from 'path';

export const CLAUDE_DIR = join(homedir(), '.claude');
export const CLAUDE_SETTINGS = join(CLAUDE_DIR, 'settings.json');

export const CC_SWITCH_DIR = join(homedir(), '.cc-switch');
export const PROFILES_DIR = join(CC_SWITCH_DIR, 'profiles');
export const STATE_FILE = join(CC_SWITCH_DIR, 'state.json');

export function getProfileDir(profileName: string): string {
  return join(PROFILES_DIR, profileName);
}

export function getProfileSettings(profileName: string): string {
  return join(getProfileDir(profileName), 'settings.json');
}
