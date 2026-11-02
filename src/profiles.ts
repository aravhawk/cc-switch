import { randomBytes } from 'node:crypto';
import {
  access,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename as fsRename,
  rm,
  stat as fsStat,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  getClaudeManagedPath,
  getClaudeSettingsPath,
  getProfileDir,
  getProfileManagedPath,
  getProfileMetaPath,
  getProfileSettings,
  getProfilesDir,
  VALID_MANAGED_PATH_NAMES,
} from './paths.js';
import { atomicWrite, ensurePrivateDir, isNotFound, readTextIfExists } from './fs-utils.js';
import { readState, updateState } from './state.js';
import { assertValidProfileName, validateProfileName } from './validation.js';
import {
  applyProvider,
  clearProvider,
  parseSettings,
  readEnv,
  replaceCredential,
  replaceModels,
  serializeSettings,
  summarizeSettings,
} from './settings.js';
import { findProvider, hasRecommendedModels, providerNeedsKey, resolveSelection } from './providers/index.js';
import type {
  ActiveProfileStatus,
  CreateProfileOptions,
  ModelOverrides,
  ProfileInfo,
  ProfileMeta,
  ProfileType,
  SettingsSummary,
} from './types.js';
import type { ModelSet, Provider, ProviderEndpoint } from './providers/types.js';

const PROFILE_META_VERSION = 1;

export const MISSING_SETTINGS_MESSAGE =
  'No ~/.claude/settings.json found. Run Claude Code once to generate it, or run the setup script provided by your provider (e.g., Z.ai).';

// --- Profile meta ---

async function readProfileMeta(profileName: string): Promise<ProfileMeta | null> {
  const data = await readTextIfExists(getProfileMetaPath(profileName));
  if (data === undefined) return null;

  let parsed: Partial<ProfileMeta>;
  try {
    parsed = JSON.parse(data) as Partial<ProfileMeta>;
  } catch {
    throw new Error(`Profile metadata for "${profileName}" is corrupt (profile.json). Delete and recreate the profile.`);
  }

  return {
    type: parsed.type === 'full' ? 'full' : 'settings',
    version: typeof parsed.version === 'number' ? parsed.version : PROFILE_META_VERSION,
    managedPaths: Array.isArray(parsed.managedPaths)
      ? parsed.managedPaths.filter((p): p is string => typeof p === 'string')
      : [],
  };
}

async function writeProfileMeta(profileName: string, type: ProfileType, managedPaths: string[]): Promise<void> {
  const meta: ProfileMeta = { type, version: PROFILE_META_VERSION, managedPaths };
  await atomicWrite(getProfileMetaPath(profileName), `${JSON.stringify(meta, null, 2)}\n`);
}

export async function getProfileType(profileName: string): Promise<ProfileType> {
  const meta = await readProfileMeta(profileName);
  return meta?.type === 'full' ? 'full' : 'settings';
}

function managedPathsOf(meta: ProfileMeta | null): string[] {
  return meta?.type === 'full' ? meta.managedPaths : [];
}

// --- Managed path sync ---

function tempSibling(path: string): string {
  return `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

type SyncResult = 'copied' | 'source-missing';

/** Copy `source` over `dest` without ever leaving `dest` half-written. */
async function replacePath(source: string, dest: string): Promise<SyncResult> {
  let sourceStat;
  try {
    sourceStat = await fsStat(source);
  } catch (error) {
    if (isNotFound(error)) return 'source-missing';
    throw error;
  }

  await mkdir(dirname(dest), { recursive: true });
  const staging = tempSibling(dest);
  try {
    if (sourceStat.isDirectory()) {
      await cp(source, staging, { recursive: true, verbatimSymlinks: true });
    } else {
      await copyFile(source, staging);
    }
    await rm(dest, { recursive: true, force: true });
    await fsRename(staging, dest);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return 'copied';
}

/** Save the live ~/.claude copy of each managed path into the profile store. */
async function mirrorManagedPaths(profileName: string, managedPaths: string[]): Promise<void> {
  for (const name of managedPaths) {
    const claudePath = getClaudeManagedPath(name);
    if (!claudePath) continue;
    // If the live path is gone, keep the stored copy rather than deleting the only backup.
    await replacePath(claudePath, getProfileManagedPath(profileName, name));
  }
}

export interface ManagedTransitionPlan {
  /** Paths to load from the target profile into the Claude directory */
  load: string[];
  /** Paths owned by the outgoing profile that the target does not manage: remove from the Claude directory */
  clear: string[];
  /** Paths the outgoing profile owned (and so has already been mirrored) */
  previouslyManaged: ReadonlySet<string>;
}

export function planManagedTransition(active: ProfileMeta | null, target: ProfileMeta | null): ManagedTransitionPlan {
  const previouslyManaged = new Set(managedPathsOf(active));
  const load = managedPathsOf(target);
  const loadSet = new Set(load);
  const clear = [...previouslyManaged].filter(name => !loadSet.has(name));
  return { load, clear, previouslyManaged };
}

async function applyManagedTransition(targetProfile: string, plan: ManagedTransitionPlan): Promise<void> {
  for (const name of plan.clear) {
    const claudePath = getClaudeManagedPath(name);
    if (claudePath) await rm(claudePath, { recursive: true, force: true });
  }

  for (const name of plan.load) {
    const claudePath = getClaudeManagedPath(name);
    if (!claudePath) continue;
    const result = await replacePath(getProfileManagedPath(targetProfile, name), claudePath);
    // The target has nothing stored for this path. If the outgoing profile owned it (and was just
    // mirrored), remove it so it does not leak into the target. Otherwise it is the user's own data.
    if (result === 'source-missing' && plan.previouslyManaged.has(name)) {
      await rm(claudePath, { recursive: true, force: true });
    }
  }
}

// --- Helpers ---

export async function checkClaudeSettings(): Promise<void> {
  try {
    await access(getClaudeSettingsPath());
  } catch {
    throw new Error(MISSING_SETTINGS_MESSAGE);
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

async function requireProfile(profileName: string): Promise<void> {
  assertValidProfileName(profileName);
  if (!(await profileExists(profileName))) {
    throw new Error(`Profile "${profileName}" does not exist`);
  }
}

/**
 * Like requireProfile, but the active profile always counts, even before it has a stored copy
 * (a fresh install's implicit "default"): its live settings.json is authoritative.
 */
async function requireProfileOrActive(profileName: string): Promise<void> {
  assertValidProfileName(profileName);
  if (await profileExists(profileName)) return;
  if ((await readState()).activeProfile === profileName) return;
  throw new Error(`Profile "${profileName}" does not exist`);
}

async function summarizeSettingsText(text: string | undefined): Promise<SettingsSummary> {
  if (text === undefined) return { models: {}, unreadable: true };
  try {
    return summarizeSettings(parseSettings(text));
  } catch {
    return { models: {}, unreadable: true };
  }
}

export async function getActiveProfileStatus(): Promise<ActiveProfileStatus> {
  const state = await readState();
  const exists = await profileExists(state.activeProfile);
  return { name: state.activeProfile, exists };
}

export async function listProfiles(): Promise<ProfileInfo[]> {
  const state = await readState();

  let entries;
  try {
    await ensurePrivateDir(getProfilesDir());
    entries = await readdir(getProfilesDir(), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const profiles: ProfileInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Anything that is not a valid profile name was not created by cc-switch (and could not be addressed).
    if (!validateProfileName(entry.name).valid) continue;
    const isActive = entry.name === state.activeProfile;
    let type: ProfileType = 'settings';
    try {
      type = await getProfileType(entry.name);
    } catch {
      // A corrupt profile.json should not hide every other profile from the list.
    }
    // The active profile's live settings are authoritative; its stored copy only updates on switch.
    const settingsText = isActive
      ? (await readTextIfExists(getClaudeSettingsPath())) ?? (await readTextIfExists(getProfileSettings(entry.name)))
      : await readTextIfExists(getProfileSettings(entry.name));
    profiles.push({
      name: entry.name,
      isActive,
      type,
      summary: await summarizeSettingsText(settingsText),
    });
  }

  return profiles.sort((a, b) => {
    if (a.isActive) return -1;
    if (b.isActive) return 1;
    return a.name.localeCompare(b.name);
  });
}

export interface ProfileDetails extends ProfileInfo {
  managedPaths: string[];
  settingsPath: string;
}

export async function getProfileDetails(profileName: string): Promise<ProfileDetails> {
  await requireProfileOrActive(profileName);
  const profiles = await listProfiles();
  let info = profiles.find(profile => profile.name === profileName);
  if (!info) {
    // The active profile before its first mirror: only the live settings exist.
    info = {
      name: profileName,
      isActive: true,
      type: 'settings',
      summary: await summarizeSettingsText(await readTextIfExists(getClaudeSettingsPath())),
    };
  }
  const meta = await readProfileMeta(profileName);
  return {
    ...info,
    managedPaths: managedPathsOf(meta),
    settingsPath: info.isActive ? getClaudeSettingsPath() : getProfileSettings(profileName),
  };
}

// --- Environment conflicts ---

const SHELL_CONFLICT_VARS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

/**
 * Provider variables exported in the current shell. They can conflict with a profile's env block
 * (for example by pointing Claude Code at a different endpoint than the profile expects).
 * Skipped inside a Claude Code session, where the environment was built from settings.json itself.
 */
export function findShellEnvConflicts(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.CLAUDECODE) return [];
  return SHELL_CONFLICT_VARS.filter(name => Boolean(env[name]));
}

// --- Switch ---

export interface SwitchResult {
  from: string;
  to: string;
  summary: SettingsSummary;
  /** Managed paths removed from the Claude directory because the target profile does not manage them */
  cleared: string[];
  warnings: string[];
}

async function mirrorActiveProfile(profileName: string): Promise<void> {
  const currentSettings = await readFile(getClaudeSettingsPath(), 'utf-8');
  await atomicWrite(getProfileSettings(profileName), currentSettings);

  const meta = await readProfileMeta(profileName);
  const managed = managedPathsOf(meta);
  if (managed.length > 0) {
    await mirrorManagedPaths(profileName, managed);
  }
}

export async function switchProfile(targetProfile: string): Promise<SwitchResult> {
  assertValidProfileName(targetProfile);
  await checkClaudeSettings();

  if (!(await profileExists(targetProfile))) {
    throw new Error(`Profile "${targetProfile}" does not exist`);
  }

  const state = await readState();
  const activeProfile = state.activeProfile;

  if (targetProfile === activeProfile) {
    throw new Error(`Profile "${targetProfile}" is already active`);
  }

  // Read and validate everything about the target before touching any file.
  const targetSettings = await readFile(getProfileSettings(targetProfile), 'utf-8').catch(error => {
    if (isNotFound(error)) throw new Error(`Profile "${targetProfile}" has no settings.json. It may be damaged; delete and recreate it.`);
    throw error;
  });
  const targetMeta = await readProfileMeta(targetProfile);
  const activeMeta = await readProfileMeta(activeProfile);

  const outgoingSettings = await readFile(getClaudeSettingsPath(), 'utf-8');

  // 1. Mirror: save the outgoing profile first so nothing is lost if we are interrupted later.
  await mirrorActiveProfile(activeProfile);

  // 2. Load the target settings, then its managed paths. If this fails half-way, put the outgoing
  //    profile back: otherwise the live files would belong to the target while state still names
  //    the outgoing profile, and the next mirror would overwrite the outgoing profile's saved copy.
  const plan = planManagedTransition(activeMeta, targetMeta);
  try {
    await atomicWrite(getClaudeSettingsPath(), targetSettings);
    await applyManagedTransition(targetProfile, plan);
  } catch (error) {
    await atomicWrite(getClaudeSettingsPath(), outgoingSettings).catch(() => undefined);
    await applyManagedTransition(activeProfile, planManagedTransition(targetMeta, activeMeta)).catch(() => undefined);
    throw error;
  }

  // 3. Only now record the new active profile.
  await updateState({ activeProfile: targetProfile });

  const warnings = findShellEnvConflicts();
  return {
    from: activeProfile,
    to: targetProfile,
    summary: await summarizeSettingsText(targetSettings),
    cleared: plan.clear,
    warnings: warnings.length > 0
      ? [`Your shell exports ${warnings.join(', ')}, which can conflict with the profile. Unset them if Claude Code reaches the wrong endpoint.`]
      : [],
  };
}

// --- Create ---

/**
 * Fail early, before any prompt or write, if a profile cannot be created under this name.
 * The active profile's name is taken even when it has no stored copy yet (the implicit "default").
 */
export async function assertCanCreate(profileName: string): Promise<void> {
  assertValidProfileName(profileName);
  if (await profileExists(profileName)) {
    throw new Error(`Profile "${profileName}" already exists`);
  }
  const state = await readState();
  if (profileName === state.activeProfile) {
    throw new Error(`"${profileName}" is the name of the currently active profile. Choose another name.`);
  }
}

export interface CreateResult {
  name: string;
  /** Managed paths removed from the Claude directory because the new profile does not manage them */
  cleared: string[];
  provider?: Provider;
  endpoint?: ProviderEndpoint;
  summary: SettingsSummary;
  type: ProfileType;
  notes: string[];
}

export async function createProfile(
  profileName: string,
  options: CreateProfileOptions = {}
): Promise<CreateResult> {
  await assertCanCreate(profileName);
  await checkClaudeSettings();

  // Resolve the template before touching the filesystem so bad input fails cleanly.
  const apiKey = options.apiKey?.trim() || undefined;
  const selection = options.template
    ? resolveSelection({
        template: options.template,
        endpoint: options.endpoint,
        baseUrl: options.baseUrl,
        models: options.models,
        authStyle: options.authStyle,
        env: options.env,
      })
    : undefined;

  if (!selection && (options.apiKey || options.endpoint || options.baseUrl || options.models || options.env)) {
    throw new Error('--api-key, --endpoint, --base-url, --env and model options can only be used with a template');
  }
  if (selection && providerNeedsKey(selection.provider) && !apiKey && !selection.provider.keyOptional) {
    throw new Error(`An API key is required for "${selection.provider.label}"`);
  }

  const liveText = await readFile(getClaudeSettingsPath(), 'utf-8');
  const liveSettings = parseSettings(liveText, '~/.claude/settings.json');
  const newSettings = selection
    ? serializeSettings(applyProvider(liveSettings, { ...selection.application, apiKey }))
    : liveText;

  const managedPaths = options.full ? (options.managedPaths ?? []) : [];
  const unknownPaths = managedPaths.filter(name => !getClaudeManagedPath(name));
  if (unknownPaths.length > 0) {
    throw new Error(`Invalid managed path(s): ${unknownPaths.join(', ')}. Valid paths: ${VALID_MANAGED_PATH_NAMES.join(', ')}`);
  }

  // Always save the profile we are leaving; creating a profile activates it.
  const state = await readState();
  const activeMeta = await readProfileMeta(state.activeProfile);
  const newMeta: ProfileMeta | null = options.full ? { type: 'full', version: PROFILE_META_VERSION, managedPaths } : null;
  await mirrorActiveProfile(state.activeProfile);
  // Like a switch: paths the outgoing profile owned but the new one does not manage leave the Claude
  // directory (they stay saved in the outgoing profile), so later edits are not silently discarded.
  const plan = planManagedTransition(activeMeta, newMeta);

  const profileDir = getProfileDir(profileName);
  let liveModified = false;
  try {
    await ensurePrivateDir(profileDir);
    await atomicWrite(getProfileSettings(profileName), newSettings);

    if (options.full) {
      await writeProfileMeta(profileName, 'full', managedPaths);
      await mirrorManagedPaths(profileName, managedPaths);
    }

    if (selection) {
      liveModified = true;
      await atomicWrite(getClaudeSettingsPath(), newSettings);
    }

    for (const name of plan.clear) {
      const claudePath = getClaudeManagedPath(name);
      if (claudePath) await rm(claudePath, { recursive: true, force: true });
    }

    await updateState({ activeProfile: profileName });
  } catch (error) {
    // Roll back so a failed create never leaves a half-built profile or provider settings behind.
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
    if (liveModified) await atomicWrite(getClaudeSettingsPath(), liveText).catch(() => undefined);
    await applyManagedTransition(state.activeProfile, planManagedTransition(newMeta, activeMeta)).catch(() => undefined);
    throw error;
  }

  return {
    name: profileName,
    cleared: plan.clear,
    provider: selection?.provider,
    endpoint: selection?.endpoint,
    summary: await summarizeSettingsText(newSettings),
    type: options.full ? 'full' : 'settings',
    notes: [...(selection?.provider.notes ?? []), ...(selection?.endpoint?.hint ? [selection.endpoint.hint] : [])],
  };
}

// --- Delete / rename ---

export async function deleteProfile(profileName: string): Promise<void> {
  await requireProfile(profileName);

  const state = await readState();
  if (profileName === state.activeProfile) {
    throw new Error(`Cannot delete active profile "${profileName}". Switch to another profile first.`);
  }

  await rm(getProfileDir(profileName), { recursive: true, force: true });
}

export async function renameProfile(oldName: string, newName: string): Promise<void> {
  assertValidProfileName(oldName, 'Invalid old profile name');
  assertValidProfileName(newName, 'Invalid new profile name');

  if (!(await profileExists(oldName))) {
    throw new Error(`Profile "${oldName}" does not exist`);
  }

  if (oldName === newName) return;

  if (await profileExists(newName)) {
    throw new Error(`Profile "${newName}" already exists`);
  }
  const currentState = await readState();
  if (newName === currentState.activeProfile) {
    throw new Error(`"${newName}" is the name of the currently active profile. Choose another name.`);
  }

  await fsRename(getProfileDir(oldName), getProfileDir(newName));

  const state = await readState();
  if (oldName === state.activeProfile) {
    await updateState({ activeProfile: newName });
  }
}

// --- Edit ---

/**
 * Settings text of a profile. For the active profile this is the live file, because the stored
 * copy only refreshes on switch.
 */
async function loadProfileSettings(profileName: string): Promise<{ text: string; isActive: boolean }> {
  await requireProfileOrActive(profileName);
  const state = await readState();
  const isActive = state.activeProfile === profileName;
  if (isActive) {
    await checkClaudeSettings();
    return { text: await readFile(getClaudeSettingsPath(), 'utf-8'), isActive };
  }
  const text = await readTextIfExists(getProfileSettings(profileName));
  if (text === undefined) {
    throw new Error(`Profile "${profileName}" has no settings.json. It may be damaged; delete and recreate it.`);
  }
  return { text, isActive };
}

async function saveProfileSettings(profileName: string, text: string, isActive: boolean): Promise<void> {
  await atomicWrite(getProfileSettings(profileName), text);
  if (isActive) await atomicWrite(getClaudeSettingsPath(), text);
}

export async function setProfileApiKey(profileName: string, apiKey: string): Promise<{ variable: string }> {
  const key = apiKey.trim();
  if (!key) throw new Error('API key cannot be empty');
  const { text, isActive } = await loadProfileSettings(profileName);
  const settings = parseSettings(text, `Settings of "${profileName}"`);
  const env = readEnv(settings);
  if (!env.ANTHROPIC_BASE_URL) {
    throw new Error(`Profile "${profileName}" does not use a custom provider endpoint, so there is no key to update`);
  }
  const { settings: updated, variable } = replaceCredential(settings, key);
  await saveProfileSettings(profileName, serializeSettings(updated), isActive);
  return { variable };
}

export async function setProfileModels(profileName: string, models: ModelOverrides): Promise<void> {
  const { text, isActive } = await loadProfileSettings(profileName);
  const settings = parseSettings(text, `Settings of "${profileName}"`);
  const resolved = expandModelOverrides(models);
  if (Object.values(resolved).every(value => !value)) {
    throw new Error('No models were provided');
  }
  // ANTHROPIC_MODEL pins the main session; if the profile has one it must follow the tier the user chose.
  if (!resolved.main && readEnv(settings).ANTHROPIC_MODEL) {
    resolved.main = resolved.sonnet ?? resolved.opus;
  }
  await saveProfileSettings(profileName, serializeSettings(replaceModels(settings, resolved)), isActive);
}

function expandModelOverrides(models: ModelOverrides): ModelSet {
  const { model, ...tiers } = models;
  return {
    main: model,
    opus: tiers.opus ?? model,
    sonnet: tiers.sonnet ?? model,
    haiku: tiers.haiku ?? model,
    fable: tiers.fable ?? model,
    // A single model for everything includes subagents, which would otherwise keep the old one.
    subagent: tiers.subagent ?? model,
  };
}

export interface RefreshResult {
  provider: Provider;
  endpoint?: ProviderEndpoint;
}

/**
 * Re-apply the current built-in defaults of the provider a profile was created from,
 * keeping its API key. Used to pick up newer model names after upgrading cc-switch.
 */
export async function refreshProfileFromTemplate(profileName: string): Promise<RefreshResult> {
  const { text, isActive } = await loadProfileSettings(profileName);
  const settings = parseSettings(text, `Settings of "${profileName}"`);
  const summary = summarizeSettings(settings);
  const provider = summary.providerId ? findProvider(summary.providerId) : undefined;
  if (!provider) {
    throw new Error(`Profile "${profileName}" does not match a built-in provider, so there are no defaults to apply`);
  }

  if (!hasRecommendedModels(provider)) {
    throw new Error(`${provider.label} has no recommended model defaults to apply; use the model you chose when creating the profile`);
  }

  const env = readEnv(settings);
  const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || undefined;
  // Cloud platforms keep their region, project and resource: they are the user's values, not defaults.
  const fieldValues: Record<string, string> = {};
  for (const field of provider.fields ?? []) {
    const value = env[field.env];
    if (value) fieldValues[field.env] = value;
  }
  const selection = resolveSelection({
    template: provider.id,
    endpoint: summary.endpointId,
    baseUrl: summary.endpointId ? undefined : summary.baseUrl,
    env: fieldValues,
  });
  const updated = applyProvider(settings, { ...selection.application, apiKey });
  // A Foundry API key is a credential the user supplied, not a default to reset.
  if (env.ANTHROPIC_FOUNDRY_API_KEY && provider.id === 'foundry') {
    updated.env = { ...(updated.env as Record<string, unknown>), ANTHROPIC_FOUNDRY_API_KEY: env.ANTHROPIC_FOUNDRY_API_KEY };
  }
  await saveProfileSettings(profileName, serializeSettings(updated), isActive);
  return { provider, endpoint: selection.endpoint };
}

/** Reset the settings of a profile to plain Claude Code defaults (no custom provider). */
export async function clearProfileProvider(profileName: string): Promise<void> {
  const { text, isActive } = await loadProfileSettings(profileName);
  const settings = parseSettings(text, `Settings of "${profileName}"`);
  await saveProfileSettings(profileName, serializeSettings(clearProvider(settings)), isActive);
}

/**
 * Credentials needed to probe a profile's endpoint. The secret never leaves this module's callers
 * except to be sent to the profile's own base URL.
 */
export async function getProfileConnection(profileName: string): Promise<{
  baseUrl?: string;
  apiKey?: string;
  credential?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  models: SettingsSummary['models'];
  providerLabel?: string;
}> {
  const { text } = await loadProfileSettings(profileName);
  const settings = parseSettings(text, `Settings of "${profileName}"`);
  const env = readEnv(settings);
  const summary = summarizeSettings(settings);
  const credential = summary.credential;
  return {
    baseUrl: env.ANTHROPIC_BASE_URL || undefined,
    apiKey: credential ? env[credential] : undefined,
    credential,
    models: summary.models,
    providerLabel: summary.providerLabel,
  };
}
