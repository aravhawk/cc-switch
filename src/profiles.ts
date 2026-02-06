import { readFile, writeFile, mkdir, rm, readdir, rename as fsRename, access } from 'fs/promises';
import { dirname } from 'path';
import { CLAUDE_SETTINGS, getProfileDir, getProfileSettings, PROFILES_DIR } from './paths.js';
import { readState, updateState } from './state.js';
import { validateProfileName } from './validation.js';
import type { ActiveProfileStatus, ProfileInfo } from './types.js';

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
    const profiles = entries
      .filter(entry => entry.isDirectory())
      .map(entry => ({
        name: entry.name,
        isActive: entry.name === state.activeProfile,
      }));

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

async function mirrorSettings(profileName: string): Promise<void> {
  const profileSettings = getProfileSettings(profileName);
  await mkdir(dirname(profileSettings), { recursive: true });

  const currentSettings = await readFile(CLAUDE_SETTINGS, 'utf-8');

  // Atomic write
  const tempFile = `${profileSettings}.tmp`;
  await writeFile(tempFile, currentSettings, 'utf-8');
  await fsRename(tempFile, profileSettings);

  // Make the newly created profile active
  await updateState({ activeProfile: profileName });
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

  // Mirror current settings to active profile before switching
  await mirrorSettings(activeProfile);

  // If target equals active, exit early
  if (targetProfile === activeProfile) {
    throw new Error(`Profile "${targetProfile}" is already active`);
  }

  // Replace settings with target profile's settings
  const targetSettings = getProfileSettings(targetProfile);
  const newSettings = await readFile(targetSettings, 'utf-8');

  // Atomic write to Claude settings
  const tempFile = `${CLAUDE_SETTINGS}.tmp`;
  await writeFile(tempFile, newSettings, 'utf-8');
  await fsRename(tempFile, CLAUDE_SETTINGS);

  // Update state
  await updateState({ activeProfile: targetProfile });
}

export async function createProfile(profileName: string): Promise<void> {
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

  // Copy current settings to new profile
  const profileSettings = getProfileSettings(profileName);
  await mkdir(dirname(profileSettings), { recursive: true });

  const currentSettings = await readFile(CLAUDE_SETTINGS, 'utf-8');

  // Atomic write
  const tempFile = `${profileSettings}.tmp`;
  await writeFile(tempFile, currentSettings, 'utf-8');
  await fsRename(tempFile, profileSettings);
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
