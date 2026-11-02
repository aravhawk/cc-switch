import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertValidProfileName } from './validation.js';

/**
 * Claude Code honors CLAUDE_CONFIG_DIR as a replacement for ~/.claude, so cc-switch does too.
 * CC_SWITCH_HOME relocates cc-switch's own store (mainly useful for tests and sandboxes).
 * Both are resolved lazily so they can change at runtime.
 */
export function getClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
}

export function getClaudeSettingsPath(): string {
  return join(getClaudeDir(), 'settings.json');
}

export function getCcSwitchDir(): string {
  return process.env.CC_SWITCH_HOME?.trim() || join(homedir(), '.cc-switch');
}

export function getProfilesDir(): string {
  return join(getCcSwitchDir(), 'profiles');
}

export function getStateFilePath(): string {
  return join(getCcSwitchDir(), 'state.json');
}

export interface ManagedPathDefinition {
  /** Name used on the command line and in profile.json */
  name: string;
  label: string;
  /** Location relative to the Claude config directory */
  relativePath: string;
  /** Included by default in new full profiles */
  isDefault: boolean;
}

export const AVAILABLE_MANAGED_PATHS: readonly ManagedPathDefinition[] = [
  { name: 'CLAUDE.md', label: 'Instructions (CLAUDE.md)', relativePath: 'CLAUDE.md', isDefault: true },
  { name: 'agents', label: 'Agents', relativePath: 'agents', isDefault: true },
  { name: 'skills', label: 'Skills', relativePath: 'skills', isDefault: true },
  { name: 'rules', label: 'Rules', relativePath: 'rules', isDefault: true },
  { name: 'commands', label: 'Slash commands', relativePath: 'commands', isDefault: true },
  { name: 'output-styles', label: 'Output styles', relativePath: 'output-styles', isDefault: false },
  { name: 'workflows', label: 'Workflows', relativePath: 'workflows', isDefault: false },
  { name: 'keybindings', label: 'Keybindings', relativePath: 'keybindings.json', isDefault: false },
  { name: 'plugins', label: 'Plugins', relativePath: 'plugins', isDefault: false },
  { name: 'teams', label: 'Teams', relativePath: 'teams', isDefault: false },
];

export const DEFAULT_MANAGED_PATHS: readonly string[] = AVAILABLE_MANAGED_PATHS
  .filter(p => p.isDefault)
  .map(p => p.name);

export const VALID_MANAGED_PATH_NAMES: readonly string[] = AVAILABLE_MANAGED_PATHS.map(p => p.name);

export function getClaudeManagedPath(managedName: string): string | undefined {
  const entry = AVAILABLE_MANAGED_PATHS.find(p => p.name === managedName);
  return entry ? join(getClaudeDir(), entry.relativePath) : undefined;
}

export function getProfileDir(profileName: string): string {
  // Defense in depth: every path under the profiles dir is derived from a validated name.
  assertValidProfileName(profileName);
  return join(getProfilesDir(), profileName);
}

export function getProfileSettings(profileName: string): string {
  return join(getProfileDir(profileName), 'settings.json');
}

export function getProfileMetaPath(profileName: string): string {
  return join(getProfileDir(profileName), 'profile.json');
}

export function getProfileManagedPath(profileName: string, managedName: string): string {
  const entry = AVAILABLE_MANAGED_PATHS.find(p => p.name === managedName);
  if (!entry) {
    throw new Error(`Invalid managed path name: "${managedName}"`);
  }
  return join(getProfileDir(profileName), entry.relativePath);
}
