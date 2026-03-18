import { readFile, writeFile, mkdir, rm, readdir, rename as fsRename, access, cp, copyFile, stat as fsStat } from 'fs/promises';
import { dirname } from 'path';
import {
  CLAUDE_SETTINGS,
  AVAILABLE_MANAGED_PATHS,
  getProfileDir,
  getProfileSettings,
  getProfileMetaPath,
  getProfileManagedPath,
  PROFILES_DIR,
} from './paths.js';
import { readState, updateState } from './state.js';
import { validateProfileName } from './validation.js';
import type {
  ActiveProfileStatus,
  CreateProfileOptions,
  ProfileInfo,
  ProfileMeta,
  ProfileType,
  ProviderTemplateName,
} from './types.js';

interface ProviderTemplateConfig {
  name: ProviderTemplateName;
  label: string;
  requiresApiKey: boolean;
  baseUrl?: string;
  haikuModel?: string;
  sonnetModel?: string;
  opusModel?: string;
  aliases?: string[];
}

const PROVIDER_TEMPLATES: ProviderTemplateConfig[] = [
  {
    name: 'anthropic',
    label: 'Anthropic (Claude default)',
    requiresApiKey: false,
    aliases: ['claude'],
  },
  {
    name: 'moonshot',
    label: 'Moonshot (Kimi)',
    requiresApiKey: true,
    baseUrl: 'https://api.kimi.com/coding/',
    haikuModel: 'kimi-for-coding',
    sonnetModel: 'kimi-for-coding',
    opusModel: 'kimi-for-coding',
    aliases: ['kimi'],
  },
  {
    name: 'zai',
    label: 'Z.ai (GLM)',
    requiresApiKey: true,
    baseUrl: 'https://api.z.ai/api/anthropic',
    haikuModel: 'glm-4.5-air',
    sonnetModel: 'glm-4.7',
    opusModel: 'glm-4.7',
    aliases: ['glm'],
  },
  {
    name: 'minimax',
    label: 'MiniMax',
    requiresApiKey: true,
    baseUrl: 'https://api.minimax.io/anthropic',
    haikuModel: 'MiniMax-M2.5',
    sonnetModel: 'MiniMax-M2.5',
    opusModel: 'MiniMax-M2.5',
  },
];

const TEMPLATE_ALIASES = new Map<string, ProviderTemplateName>();
for (const template of PROVIDER_TEMPLATES) {
  TEMPLATE_ALIASES.set(template.name.toLowerCase(), template.name);
  for (const alias of template.aliases ?? []) {
    TEMPLATE_ALIASES.set(alias.toLowerCase(), template.name);
  }
}

function getTemplateConfig(name: ProviderTemplateName): ProviderTemplateConfig | undefined {
  return PROVIDER_TEMPLATES.find(template => template.name === name);
}

// --- Profile type / meta ---

export async function getProfileType(profileName: string): Promise<ProfileType> {
  const meta = await readProfileMeta(profileName);
  return meta?.type === 'full' ? 'full' : 'settings';
}

async function readProfileMeta(profileName: string): Promise<ProfileMeta | null> {
  let data: string;
  try {
    data = await readFile(getProfileMetaPath(profileName), 'utf-8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(data) as ProfileMeta;
  } catch {
    throw new Error(`Profile metadata for "${profileName}" is corrupt (profile.json). Delete and recreate the profile.`);
  }
}

async function writeProfileMeta(profileName: string, type: ProfileType, managedPaths: string[]): Promise<void> {
  const metaPath = getProfileMetaPath(profileName);
  const meta: ProfileMeta = { type, version: 1, managedPaths };
  const tempFile = `${metaPath}.tmp`;
  await writeFile(tempFile, JSON.stringify(meta, null, 2), 'utf-8');
  await fsRename(tempFile, metaPath);
}

// --- Managed path sync ---

async function syncManagedPath(source: string, dest: string): Promise<void> {
  // Check if source exists before touching dest
  let sourceStat;
  try {
    sourceStat = await fsStat(source);
  } catch (e: any) {
    if (e.code === 'ENOENT') return; // Source gone — leave dest alone
    throw e;
  }

  // Source exists, safe to replace dest
  await rm(dest, { recursive: true, force: true });

  if (sourceStat.isDirectory()) {
    await cp(source, dest, { recursive: true, verbatimSymlinks: true });
  } else {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(source, dest);
  }
}

function resolveManagedClaudePath(managedName: string): string | undefined {
  const entry = AVAILABLE_MANAGED_PATHS.find(p => p.name === managedName);
  return entry?.claudePath;
}

async function mirrorFullProfile(profileName: string, managedPaths: string[]): Promise<void> {
  for (const name of managedPaths) {
    const claudePath = resolveManagedClaudePath(name);
    if (!claudePath) continue;
    const destPath = getProfileManagedPath(profileName, name);
    await syncManagedPath(claudePath, destPath);
  }
}

async function loadFullProfile(profileName: string, managedPaths: string[]): Promise<void> {
  for (const name of managedPaths) {
    const claudePath = resolveManagedClaudePath(name);
    if (!claudePath) continue;
    const sourcePath = getProfileManagedPath(profileName, name);
    await syncManagedPath(sourcePath, claudePath);
  }
}

// --- Provider templates ---

export function getProviderTemplates(): Array<{
  name: ProviderTemplateName;
  label: string;
  requiresApiKey: boolean;
}> {
  return PROVIDER_TEMPLATES.map(template => ({
    name: template.name,
    label: template.label,
    requiresApiKey: template.requiresApiKey,
  }));
}

export function resolveTemplateName(input?: string): ProviderTemplateName | undefined {
  if (!input) {
    return undefined;
  }
  return TEMPLATE_ALIASES.get(input.trim().toLowerCase());
}

export async function checkClaudeSettings(): Promise<void> {
  try {
    await access(CLAUDE_SETTINGS);
  } catch {
    throw new Error(
      'No ~/.claude/settings.json found. Run Claude Code once to generate it, or run the setup script provided by your provider (e.g., Z.ai).'
    );
  }
}

export async function listProfiles(): Promise<ProfileInfo[]> {
  const state = await readState();

  try {
    await mkdir(PROFILES_DIR, { recursive: true });
    const entries = await readdir(PROFILES_DIR, { withFileTypes: true });
    const profiles: ProfileInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const type = await getProfileType(entry.name);
      profiles.push({
        name: entry.name,
        isActive: entry.name === state.activeProfile,
        type,
      });
    }

    return profiles.sort((a, b) => {
      if (a.isActive) return -1;
      if (b.isActive) return 1;
      return a.name.localeCompare(b.name);
    });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function profileExists(profileName: string): Promise<boolean> {
  try {
    await access(getProfileDir(profileName));
    return true;
  } catch {
    return false;
  }
}

export async function getActiveProfileStatus(): Promise<ActiveProfileStatus> {
  const state = await readState();
  const exists = await profileExists(state.activeProfile);
  return { name: state.activeProfile, exists };
}

function applyTemplateOverrides(
  settingsContent: string,
  template: ProviderTemplateConfig,
  apiKey?: string
): string {
  const parsed = JSON.parse(settingsContent);
  const env = { ...(parsed.env ?? {}) };

  delete env.ANTHROPIC_API_KEY;

  if (template.baseUrl) {
    env.ANTHROPIC_BASE_URL = template.baseUrl;
  }
  if (template.requiresApiKey && apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = apiKey;
  } else if (apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = apiKey;
  }

  if (template.haikuModel) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = template.haikuModel;
  }
  if (template.sonnetModel) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = template.sonnetModel;
  }
  if (template.opusModel) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = template.opusModel;
  }

  parsed.env = env;
  return JSON.stringify(parsed, null, 2);
}

async function mirrorActiveProfile(profileName: string): Promise<void> {
  const profileSettings = getProfileSettings(profileName);
  await mkdir(dirname(profileSettings), { recursive: true });

  const currentSettings = await readFile(CLAUDE_SETTINGS, 'utf-8');

  // Atomic write for settings.json
  const tempFile = `${profileSettings}.tmp`;
  await writeFile(tempFile, currentSettings, 'utf-8');
  await fsRename(tempFile, profileSettings);

  // If full profile, also mirror managed paths
  const meta = await readProfileMeta(profileName);
  if (meta?.type === 'full' && meta.managedPaths.length > 0) {
    await mirrorFullProfile(profileName, meta.managedPaths);
  }
}

export async function switchProfile(targetProfile: string): Promise<void> {
  // Validate target profile name
  const validation = validateProfileName(targetProfile);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // Check Claude settings exists
  await checkClaudeSettings();

  // Validate target profile exists
  if (!(await profileExists(targetProfile))) {
    throw new Error(`Profile "${targetProfile}" does not exist`);
  }

  // Get current active profile
  const state = await readState();
  const activeProfile = state.activeProfile;

  // Exit early before any I/O
  if (targetProfile === activeProfile) {
    throw new Error(`Profile "${targetProfile}" is already active`);
  }

  // Mirror current active profile (settings + managed paths if full)
  await mirrorActiveProfile(activeProfile);

  // Replace settings with target profile's settings
  const targetSettings = getProfileSettings(targetProfile);
  const newSettings = await readFile(targetSettings, 'utf-8');

  // Atomic write to Claude settings
  const tempFile = `${CLAUDE_SETTINGS}.tmp`;
  await writeFile(tempFile, newSettings, 'utf-8');
  await fsRename(tempFile, CLAUDE_SETTINGS);

  // Handle managed paths based on profile types
  const activeMeta = await readProfileMeta(activeProfile);
  const targetMeta = await readProfileMeta(targetProfile);

  if (targetMeta?.type === 'full' && targetMeta.managedPaths.length > 0) {
    // Target is full — load its managed paths
    await loadFullProfile(targetProfile, targetMeta.managedPaths);
  } else if (activeMeta?.type === 'full' && activeMeta.managedPaths.length > 0) {
    // Switching from full to settings-only — clean up managed paths from ~/.claude
    for (const name of activeMeta.managedPaths) {
      const claudePath = resolveManagedClaudePath(name);
      if (claudePath) await rm(claudePath, { recursive: true, force: true });
    }
  }

  // Update state
  await updateState({ activeProfile: targetProfile });
}

export async function createProfile(
  profileName: string,
  options?: CreateProfileOptions
): Promise<void> {
  // Validate profile name
  const validation = validateProfileName(profileName);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // Check Claude settings exists
  await checkClaudeSettings();

  // Check if profile already exists
  if (await profileExists(profileName)) {
    throw new Error(`Profile "${profileName}" already exists`);
  }

  const templateConfig = options?.template ? getTemplateConfig(options.template) : undefined;
  if (options?.template && !templateConfig) {
    throw new Error(`Unknown template "${options.template}"`);
  }

  const apiKey = options?.apiKey?.trim();
  if (templateConfig?.requiresApiKey && !apiKey) {
    throw new Error(`API key is required for template "${templateConfig.label}"`);
  }

  if (!templateConfig && options?.apiKey) {
    throw new Error('API key can only be used with a template');
  }

  // Copy current settings to new profile
  const profileSettings = getProfileSettings(profileName);
  await mkdir(dirname(profileSettings), { recursive: true });

  const currentSettings = await readFile(CLAUDE_SETTINGS, 'utf-8');
  let activeProfileForTemplate: string | undefined;

  if (templateConfig) {
    const state = await readState();
    activeProfileForTemplate = state.activeProfile;
  }

  let settingsToWrite = currentSettings;

  if (templateConfig) {
    await mirrorActiveProfile(activeProfileForTemplate ?? 'default');
    settingsToWrite = applyTemplateOverrides(currentSettings, templateConfig, apiKey);
  }

  // Atomic write
  const tempFile = `${profileSettings}.tmp`;
  await writeFile(tempFile, settingsToWrite, 'utf-8');
  await fsRename(tempFile, profileSettings);

  if (templateConfig) {
    const tempCurrentSettings = `${CLAUDE_SETTINGS}.tmp`;
    await writeFile(tempCurrentSettings, settingsToWrite, 'utf-8');
    await fsRename(tempCurrentSettings, CLAUDE_SETTINGS);
  }

  // If full profile, write meta and copy managed paths from ~/.claude
  if (options?.full) {
    const managedPaths = options.managedPaths ?? [];
    await writeProfileMeta(profileName, 'full', managedPaths);
    await mirrorFullProfile(profileName, managedPaths);
  }

  // Make the newly created profile active
  await updateState({ activeProfile: profileName });
}

export async function deleteProfile(profileName: string): Promise<void> {
  // Validate profile name
  const validation = validateProfileName(profileName);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // Check if profile exists
  if (!(await profileExists(profileName))) {
    throw new Error(`Profile "${profileName}" does not exist`);
  }

  // Block deletion if target is active
  const state = await readState();
  if (profileName === state.activeProfile) {
    throw new Error(`Cannot delete active profile "${profileName}". Switch to another profile first.`);
  }

  // Remove profile directory
  await rm(getProfileDir(profileName), { recursive: true, force: true });
}

export async function renameProfile(oldName: string, newName: string): Promise<void> {
  // Validate old name
  const oldValidation = validateProfileName(oldName);
  if (!oldValidation.valid) {
    throw new Error(`Invalid old profile name: ${oldValidation.error}`);
  }

  // Validate new name
  const newValidation = validateProfileName(newName);
  if (!newValidation.valid) {
    throw new Error(`Invalid new profile name: ${newValidation.error}`);
  }

  // Check if old profile exists
  if (!(await profileExists(oldName))) {
    throw new Error(`Profile "${oldName}" does not exist`);
  }

  // No-op if names are identical
  if (oldName === newName) {
    return;
  }

  // Check if new profile already exists
  if (await profileExists(newName)) {
    throw new Error(`Profile "${newName}" already exists`);
  }

  // Rename directory
  await fsRename(getProfileDir(oldName), getProfileDir(newName));

  // If old name is active, update state
  const state = await readState();
  if (oldName === state.activeProfile) {
    await updateState({ activeProfile: newName });
  }
}
