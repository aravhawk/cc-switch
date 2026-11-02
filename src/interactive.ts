import * as clack from '@clack/prompts';
import { cliVersion } from './cli.js';
import { needsInsecureTransportWarning, testConnection, validateBaseUrl } from './connection-test.js';
import {
  clearProfileProvider,
  createProfile,
  deleteProfile,
  getActiveProfileStatus,
  getProfileConnection,
  getProfileDetails,
  listProfiles,
  refreshProfileFromTemplate,
  renameProfile,
  setProfileApiKey,
  setProfileModels,
  switchProfile,
} from './profiles.js';
import { AVAILABLE_MANAGED_PATHS, DEFAULT_MANAGED_PATHS } from './paths.js';
import {
  PROVIDER_CATEGORY_LABELS,
  PROVIDERS,
  findProvider,
  hasRecommendedModels,
  providerNeedsKey,
  resolveSelection,
  type Provider,
  type ProviderEndpoint,
} from './providers/index.js';
import { describeTarget, formatDetailsBlock, formatProviderSummary, isInteractiveTerminal, pc, primaryModel } from './ui.js';
import { validateProfileName } from './validation.js';
import { maskSecret } from './settings.js';
import type { ModelOverrides, ProfileInfo } from './types.js';

const CATEGORY_ORDER = Object.keys(PROVIDER_CATEGORY_LABELS);

function cancelled(): never {
  clack.cancel('Operation cancelled');
  process.exit(0);
}

/** Unwrap a prompt result, exiting cleanly if the user pressed Ctrl+C / Esc. */
function answer<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) cancelled();
  return value as Exclude<T, symbol>;
}

function profileHint(profile: ProfileInfo): string {
  const model = primaryModel(profile.summary);
  const parts = [describeTarget(profile.summary)];
  if (model) parts.push(model);
  if (profile.type === 'full') parts.push('full');
  return parts.join('  ');
}

function profileOptions(profiles: ProfileInfo[]) {
  return profiles.map(profile => ({
    value: profile.name,
    label: profile.isActive ? `${profile.name} (active)` : profile.name,
    hint: profileHint(profile),
  }));
}

function nameValidator(existing: Set<string>) {
  return (value: string | undefined): string | undefined => {
    const result = validateProfileName(value ?? '');
    if (!result.valid) return result.error;
    if (existing.has(value!)) return `Profile "${value}" already exists`;
    return undefined;
  };
}

// --- Provider selection ---

function providerOptions() {
  const rank = (provider: Provider) => CATEGORY_ORDER.indexOf(provider.category);
  return [...PROVIDERS]
    .sort((a, b) => rank(a) - rank(b))
    .map(provider => ({
      value: provider.id,
      label: provider.label,
      hint: PROVIDER_CATEGORY_LABELS[provider.category] === provider.label ? undefined : PROVIDER_CATEGORY_LABELS[provider.category],
    }));
}

async function chooseEndpoint(provider: Provider): Promise<ProviderEndpoint | undefined> {
  if (provider.endpoints.length <= 1) return provider.endpoints[0];
  const id = answer(await clack.select({
    message: 'Which endpoint?',
    options: provider.endpoints.map(endpoint => ({
      value: endpoint.id,
      label: endpoint.label,
      hint: endpoint.hint ?? endpoint.baseUrl,
    })),
  }));
  return provider.endpoints.find(endpoint => endpoint.id === id);
}

async function chooseModels(provider: Provider, endpoint: ProviderEndpoint | undefined): Promise<ModelOverrides | undefined> {
  const defaults = endpoint?.models ?? provider.models ?? {};

  if (provider.requiresModel) {
    const model = answer(await clack.text({
      message: 'Model ID to use:',
      placeholder: provider.modelExample,
      validate: value => (!value || !value.trim() ? 'A model ID is required' : undefined),
    }));
    return { model: model.trim() };
  }

  if (provider.id === 'custom') {
    const model = answer(await clack.text({
      message: 'Model ID (leave empty to keep Claude Code\'s default model names):',
      placeholder: 'my-model',
    }));
    return model.trim() ? { model: model.trim() } : undefined;
  }

  if (!defaults.opus && !defaults.sonnet && !defaults.haiku && !defaults.main) return undefined;

  const lines = ([
    ['Opus', defaults.opus],
    ['Sonnet', defaults.sonnet],
    ['Haiku', defaults.haiku],
  ] as const)
    .filter(([, id]) => id)
    .map(([tier, id]) => `${tier.padEnd(7)} ${id}`);
  clack.note(lines.join('\n'), 'Recommended models');

  const mode = answer(await clack.select({
    message: 'Models',
    options: [
      { value: 'default', label: 'Use the recommended models' },
      { value: 'single', label: 'Use one model for everything' },
      { value: 'tiers', label: 'Choose a model for each tier' },
    ],
  }));

  if (mode === 'default') return undefined;

  if (mode === 'single') {
    const model = answer(await clack.text({
      message: 'Model ID:',
      initialValue: defaults.sonnet ?? defaults.main,
      validate: value => (!value || !value.trim() ? 'A model ID is required' : undefined),
    }));
    return { model: model.trim() };
  }

  const ask = async (tier: string, initial: string | undefined) =>
    answer(await clack.text({ message: `${tier} model:`, initialValue: initial })).trim() || undefined;
  return {
    opus: await ask('Opus', defaults.opus),
    sonnet: await ask('Sonnet', defaults.sonnet),
    haiku: await ask('Haiku (and background tasks)', defaults.haiku),
  };
}

async function collectFields(provider: Provider): Promise<Record<string, string> | undefined> {
  if (!provider.fields?.length) return undefined;
  const env: Record<string, string> = {};
  for (const field of provider.fields) {
    const value = answer(await clack.text({
      message: `${field.label}${field.required ? '' : ' (optional)'}:`,
      placeholder: field.placeholder,
      defaultValue: field.defaultValue,
      validate: input => (field.required && !input?.trim() && field.defaultValue === undefined ? `${field.label} is required` : undefined),
    }));
    if (value.trim()) env[field.env] = value.trim();
  }
  return env;
}

interface CreationPlan {
  template?: string;
  endpoint?: string;
  baseUrl?: string;
  authStyle?: 'token' | 'api-key';
  models?: ModelOverrides;
  env?: Record<string, string>;
  apiKey?: string;
}

async function planFromTemplate(): Promise<CreationPlan> {
  const providerId = answer(await clack.autocomplete({
    message: 'Provider (type to search):',
    options: providerOptions(),
    maxItems: 10,
  }));
  const provider = findProvider(providerId)!;
  clack.note(formatProviderSummary(provider), provider.label);

  const plan: CreationPlan = { template: provider.id };

  const endpoint = await chooseEndpoint(provider);
  plan.endpoint = endpoint?.id;

  if (provider.id === 'custom') {
    plan.baseUrl = answer(await clack.text({
      message: 'Base URL (without /v1):',
      placeholder: 'https://llm.example.com',
      validate: value => (value && value.trim() ? validateBaseUrl(value.trim()) : 'A base URL is required'),
    })).trim();
    plan.authStyle = answer(await clack.select({
      message: 'How does the endpoint expect the key?',
      options: [
        { value: 'token', label: 'Authorization: Bearer (ANTHROPIC_AUTH_TOKEN)', hint: 'most gateways' },
        { value: 'api-key', label: 'x-api-key header (ANTHROPIC_API_KEY)' },
      ],
    })) as 'token' | 'api-key';
  }

  plan.env = await collectFields(provider);

  if (providerNeedsKey(provider)) {
    const keyUrl = endpoint?.keyUrl ?? provider.keyUrl;
    if (keyUrl) clack.log.info(`Get a key: ${pc.cyan(keyUrl)}`);
    const optional = Boolean(provider.keyOptional);
    const key = answer(await clack.password({
      message: optional ? 'API key (leave empty if the endpoint needs none):' : `API key for ${provider.label}:`,
      validate: value => (!optional && (!value || !value.trim()) ? 'API key cannot be empty' : undefined),
    }));
    plan.apiKey = key.trim() || undefined;
  }

  plan.models = await chooseModels(provider, endpoint);
  return plan;
}

async function runCreateFlow(profiles: ProfileInfo[]): Promise<void> {
  // The active profile's name is taken even before it has a stored copy (the implicit "default").
  const takenNames = new Set(profiles.map(p => p.name));
  takenNames.add((await getActiveProfileStatus()).name);
  const name = answer(await clack.text({
    message: 'Profile name:',
    placeholder: 'e.g. kimi, work, local',
    validate: nameValidator(takenNames),
  })).trim();

  const source = answer(await clack.select({
    message: 'Start from',
    options: [
      { value: 'template', label: 'A provider', hint: 'Anthropic, Z.ai, Kimi, DeepSeek, MiniMax, Ollama, OpenRouter, ...' },
      { value: 'copy', label: 'My current settings', hint: 'copy ~/.claude/settings.json as it is' },
    ],
  }));

  const plan: CreationPlan = source === 'template' ? await planFromTemplate() : {};

  const type = answer(await clack.select({
    message: 'What should switching change?',
    options: [
      { value: 'settings', label: 'Settings only', hint: 'settings.json' },
      { value: 'full', label: 'Settings plus instructions, agents and skills', hint: 'each profile keeps its own copies' },
    ],
  }));

  let managedPaths: string[] | undefined;
  if (type === 'full') {
    managedPaths = answer(await clack.multiselect({
      message: 'Which paths should this profile manage?',
      options: AVAILABLE_MANAGED_PATHS.map(p => ({ value: p.name, label: p.label })),
      initialValues: [...DEFAULT_MANAGED_PATHS],
      required: false,
    }));
  }

  // Review before writing anything.
  const review: string[] = [`Profile   ${name}${type === 'full' ? ' (full)' : ''}`];
  if (plan.template) {
    const selection = resolveSelection({
      template: plan.template,
      endpoint: plan.endpoint,
      baseUrl: plan.baseUrl,
      authStyle: plan.authStyle,
      models: plan.models,
      env: plan.env,
    });
    review.push(`Provider  ${selection.provider.label}${selection.endpoint && selection.provider.endpoints.length > 1 ? ` (${selection.endpoint.label})` : ''}`);
    if (selection.application.baseUrl) review.push(`URL       ${selection.application.baseUrl}`);
    const { models } = selection.application;
    for (const [tier, id] of [['Opus', models.opus], ['Sonnet', models.sonnet], ['Haiku', models.haiku]] as const) {
      if (id) review.push(`${tier.padEnd(9)} ${id}`);
    }
    if (plan.apiKey) review.push(`API key   ${maskSecret(plan.apiKey)}`);
    if (selection.application.baseUrl && needsInsecureTransportWarning(selection.application.baseUrl)) {
      review.push(pc.yellow('Warning   this URL is not HTTPS; the key will be sent unencrypted'));
    }
  } else {
    review.push('Source    copy of your current settings');
  }
  clack.note(review.join('\n'), 'Review');

  const confirmed = answer(await clack.confirm({ message: 'Create and switch to this profile?', initialValue: true }));
  if (!confirmed) {
    clack.outro('Nothing was changed');
    return;
  }

  const spin = clack.spinner();
  spin.start('Creating profile');
  let result;
  try {
    result = await createProfile(name, {
      template: plan.template,
      endpoint: plan.endpoint,
      baseUrl: plan.baseUrl,
      authStyle: plan.authStyle,
      models: plan.models,
      env: plan.env,
      apiKey: plan.apiKey,
      full: type === 'full',
      managedPaths,
    });
  } catch (error) {
    spin.error('Could not create the profile');
    throw error;
  }
  spin.stop(`Created profile "${name}" and made it active`);
  if (result.cleared.length > 0) {
    clack.log.info(`Removed ${result.cleared.join(', ')} from the Claude config directory (still saved in the previous profile)`);
  }

  for (const note of result.notes) clack.log.message(pc.dim(note));

  if (result.summary.baseUrl) {
    const test = answer(await clack.confirm({
      message: 'Send a tiny test request to check the endpoint, key and model?',
      initialValue: true,
    }));
    if (test) {
      const testSpin = clack.spinner();
      testSpin.start('Testing connection');
      const ok = await probeProfile(name);
      testSpin.stop(ok.message);
      if (!ok.good) clack.log.warn('The profile was created anyway. Fix the problem and run "cc-switch --test", or edit the profile from the menu.');
    }
  }
}

/** Run the connection test without writing to stdout (the spinner owns the terminal). */
async function probeProfile(profileName: string): Promise<{ good: boolean; message: string }> {
  const result = await testConnection(await getProfileConnection(profileName));
  const good = result.status === 'ok' || result.status === 'reachable' || result.status === 'skipped';
  return { good, message: result.message };
}

// --- Other flows ---

async function runSwitchFlow(profiles: ProfileInfo[]): Promise<void> {
  const others = profiles.filter(p => !p.isActive);
  if (others.length === 0) {
    clack.outro('Only the active profile exists. Create another one first.');
    return;
  }
  const target = answer(await clack.select({
    message: 'Switch to',
    options: profileOptions(profiles),
    initialValue: others[0]!.name,
  }));
  const active = profiles.find(p => p.isActive);
  if (active && target === active.name) {
    clack.outro(`"${target}" is already active`);
    return;
  }
  const result = await switchProfile(target);
  if (result.cleared.length > 0) {
    clack.log.info(`Removed ${result.cleared.join(', ')} from the Claude config directory (still saved in profile "${result.from}")`);
  }
  for (const warning of result.warnings) clack.log.warn(warning);
  clack.outro(`Switched to profile "${result.to}" (${describeTarget(result.summary)})`);
}

async function runEditFlow(profiles: ProfileInfo[]): Promise<void> {
  const name = answer(await clack.select({ message: 'Edit which profile?', options: profileOptions(profiles) }));
  const details = await getProfileDetails(name);
  clack.note(formatDetailsBlock(details), 'Current settings');

  const provider = details.summary.providerId ? findProvider(details.summary.providerId) : undefined;
  const hasEndpoint = Boolean(details.summary.baseUrl);

  const options: Array<{ value: string; label: string; hint?: string }> = [];
  if (hasEndpoint) options.push({ value: 'key', label: 'Update API key' });
  options.push({ value: 'models', label: 'Change models' });
  if (provider && hasRecommendedModels(provider)) {
    options.push({ value: 'refresh', label: 'Reset to the latest recommended models', hint: provider.label });
  }
  if (hasEndpoint) options.push({ value: 'test', label: 'Test connection' });
  if (hasEndpoint) options.push({ value: 'clear', label: 'Remove the custom provider', hint: 'back to plain Claude Code' });

  const action = answer(await clack.select({ message: 'What do you want to change?', options }));

  switch (action) {
    case 'key': {
      const key = answer(await clack.password({
        message: 'New API key:',
        validate: value => (!value || !value.trim() ? 'API key cannot be empty' : undefined),
      }));
      const { variable } = await setProfileApiKey(name, key);
      clack.outro(`Updated ${variable} for "${name}"`);
      return;
    }
    case 'models': {
      const model = answer(await clack.text({
        message: 'Model ID for every tier (leave empty to set tiers separately):',
        placeholder: details.summary.models.sonnet ?? details.summary.models.main,
      })).trim();
      if (model) {
        await setProfileModels(name, { model });
      } else {
        const ask = async (label: string, current: string | undefined) =>
          answer(await clack.text({ message: `${label} model:`, initialValue: current })).trim() || undefined;
        await setProfileModels(name, {
          opus: await ask('Opus', details.summary.models.opus),
          sonnet: await ask('Sonnet', details.summary.models.sonnet),
          haiku: await ask('Haiku', details.summary.models.haiku),
        });
      }
      clack.outro(`Updated models for "${name}"`);
      return;
    }
    case 'refresh': {
      const result = await refreshProfileFromTemplate(name);
      clack.outro(`Applied the latest ${result.provider.label} defaults to "${name}"`);
      return;
    }
    case 'test': {
      const spin = clack.spinner();
      spin.start('Testing connection');
      const result = await probeProfile(name);
      spin.stop(result.message);
      clack.outro(result.good ? 'Done' : 'The endpoint did not accept the request');
      return;
    }
    case 'clear': {
      const sure = answer(await clack.confirm({
        message: `Remove the custom endpoint, key and model mapping from "${name}"?`,
        initialValue: false,
      }));
      if (!sure) {
        clack.outro('Nothing was changed');
        return;
      }
      await clearProfileProvider(name);
      clack.outro(`"${name}" now uses plain Claude Code settings`);
      return;
    }
  }
}

async function runDeleteFlow(profiles: ProfileInfo[]): Promise<void> {
  const candidates = profiles.filter(p => !p.isActive);
  if (candidates.length === 0) {
    clack.outro('No profiles available to delete. Cannot delete the active profile.');
    return;
  }
  const name = answer(await clack.select({ message: 'Delete which profile?', options: profileOptions(candidates) }));
  const sure = answer(await clack.confirm({
    message: `Delete profile "${name}"? This removes its stored settings, key and files.`,
    initialValue: false,
  }));
  if (!sure) {
    clack.outro('Deletion cancelled');
    return;
  }
  await deleteProfile(name);
  clack.outro(`Deleted profile "${name}"`);
}

async function runRenameFlow(profiles: ProfileInfo[]): Promise<void> {
  const oldName = answer(await clack.select({ message: 'Rename which profile?', options: profileOptions(profiles) }));
  const taken = new Set(profiles.map(p => p.name));
  taken.delete(oldName);
  taken.add((await getActiveProfileStatus()).name);
  taken.delete(oldName);
  const newName = answer(await clack.text({
    message: 'New name:',
    initialValue: oldName,
    validate: nameValidator(taken),
  })).trim();
  if (newName === oldName) {
    clack.outro('Profile name unchanged');
    return;
  }
  await renameProfile(oldName, newName);
  clack.outro(`Renamed profile "${oldName}" to "${newName}"`);
}

async function runDetailsFlow(profiles: ProfileInfo[]): Promise<void> {
  const name = answer(await clack.select({
    message: 'Show which profile?',
    options: profileOptions(profiles),
    initialValue: profiles.find(p => p.isActive)?.name,
  }));
  clack.note(formatDetailsBlock(await getProfileDetails(name)), name);
  clack.outro('Done');
}

async function runTestFlow(profiles: ProfileInfo[]): Promise<void> {
  const candidates = profiles.filter(p => p.summary.baseUrl);
  if (candidates.length === 0) {
    clack.outro('No profile uses a custom endpoint, so there is nothing to test.');
    return;
  }
  const name = answer(await clack.select({
    message: 'Test which profile?',
    options: profileOptions(candidates),
    initialValue: candidates.find(p => p.isActive)?.name ?? candidates[0]!.name,
  }));
  const spin = clack.spinner();
  spin.start('Testing connection');
  const result = await probeProfile(name);
  spin.stop(result.message);
  clack.outro(result.good ? 'Done' : 'The endpoint did not accept the request');
}

export async function interactiveMode(): Promise<void> {
  if (!isInteractiveTerminal()) {
    console.error('Interactive mode needs a terminal. Run "cc-switch --help" for the non-interactive commands.');
    process.exitCode = 1;
    return;
  }

  clack.intro(`${pc.bold('cc-switch')} ${pc.dim(`v${cliVersion}`)}  Claude Code profile manager`);

  try {
    const profiles = await listProfiles();
    const hasProfiles = profiles.length > 0;
    const active = profiles.find(p => p.isActive);

    if (active) {
      clack.log.info(`Active: ${pc.bold(active.name)}  ${pc.dim(profileHint(active))}`);
    } else {
      const status = await getActiveProfileStatus();
      clack.log.info(hasProfiles
        ? `Active profile "${status.name}" has no stored copy yet; switching away will save it.`
        : 'No profiles yet. Creating one saves your current settings as the starting point.');
    }

    const action = answer(await clack.select({
      message: 'What would you like to do?',
      options: hasProfiles
        ? [
            { value: 'switch', label: 'Switch profile', hint: `${profiles.length} available` },
            { value: 'create', label: 'Create profile', hint: 'pick from the provider catalog' },
            { value: 'edit', label: 'Edit profile', hint: 'API key, models' },
            { value: 'test', label: 'Test connection' },
            { value: 'show', label: 'Show details' },
            { value: 'rename', label: 'Rename profile' },
            { value: 'delete', label: 'Delete profile' },
          ]
        : [{ value: 'create', label: 'Create your first profile' }],
    }));

    switch (action) {
      case 'switch': await runSwitchFlow(profiles); break;
      case 'create': {
        await runCreateFlow(profiles);
        clack.outro('All set. Start Claude Code to use the new profile.');
        break;
      }
      case 'edit': await runEditFlow(profiles); break;
      case 'test': await runTestFlow(profiles); break;
      case 'show': await runDetailsFlow(profiles); break;
      case 'rename': await runRenameFlow(profiles); break;
      case 'delete': await runDeleteFlow(profiles); break;
    }
  } catch (error) {
    clack.outro(pc.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 1;
  }
}
