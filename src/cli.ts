import { Command, CommanderError, Option } from 'commander';
import * as clack from '@clack/prompts';
import { version as cliVersion } from '../package.json';
import { hasExplicitApiKeySource, resolveApiKey, type ApiKeyFlags } from './api-key.js';
import { needsInsecureTransportWarning, testConnection } from './connection-test.js';
import {
  assertCanCreate,
  createProfile,
  deleteProfile,
  getActiveProfileStatus,
  getProfileConnection,
  getProfileDetails,
  listProfiles,
  refreshProfileFromTemplate,
  renameProfile,
  setProfileApiKey,
  switchProfile,
} from './profiles.js';
import { DEFAULT_MANAGED_PATHS, VALID_MANAGED_PATH_NAMES } from './paths.js';
import { PROVIDERS, findProvider, providerNeedsKey } from './providers/index.js';
import { formatCurrentLine, isInteractiveTerminal, pc, printProfileDetails, printProfileList, printProviders } from './ui.js';
import type { CreateResult, SwitchResult } from './profiles.js';
import type { ModelOverrides } from './types.js';

export { cliVersion };

interface CliOptions extends ApiKeyFlags {
  switch?: string;
  create?: string;
  delete?: string;
  rename?: string[];
  to?: string;
  current?: boolean;
  list?: boolean;
  show?: string | true;
  test?: string | true;
  setKey?: string;
  refresh?: string;
  providers?: boolean;
  template?: string;
  endpoint?: string;
  baseUrl?: string;
  authStyle?: 'token' | 'api-key';
  model?: string;
  opusModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
  env: string[];
  full?: boolean;
  include?: string;
  verify?: boolean;
  json?: boolean;
}

type Action = 'switch' | 'create' | 'delete' | 'rename' | 'current' | 'list' | 'show' | 'test' | 'set-key' | 'refresh' | 'providers';

class UsageError extends Error {}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('cc-switch')
    .description('Profile manager for Claude Code: switch between Anthropic, open-model providers, gateways and local models')
    .version(cliVersion, '-V, --version', 'output the version number')
    .argument('[profile]', 'Profile name to switch to')
    .option('--switch <name>', 'Switch to a different profile')
    .option('--create <name>', 'Create a new profile (from current settings, or from --template)')
    .option('--delete <name>', 'Delete a profile')
    .option('--rename <names...>', 'Rename a profile')
    .option('--to <name>', 'New name for rename')
    .option('--current', 'Show the current active profile')
    .option('--list', 'List all profiles')
    .option('--show [name]', 'Show details of a profile (default: the active one)')
    .option('--test [name]', 'Send a tiny request to check the endpoint, key and model (default: the active profile)')
    .option('--set-key <name>', 'Replace the API key of a profile')
    .option('--refresh <name>', 'Re-apply the current recommended models and settings of the profile\'s provider (keeps the key)')
    .option('--providers', 'List the built-in provider templates')
    .option('--template <provider>', 'Create the profile from a provider template (see --providers)')
    .option('--endpoint <id>', 'Endpoint variant of the template (region, plan, ...)')
    .option('--base-url <url>', 'Base URL for the "custom" template, or to override a template')
    .addOption(new Option('--auth-style <style>', 'Credential variable for the "custom" template').choices(['token', 'api-key']))
    .option('--model <id>', 'Use one model for every tier (required by gateways and local servers)')
    .option('--opus-model <id>', 'Model for the Opus tier')
    .option('--sonnet-model <id>', 'Model for the Sonnet tier')
    .option('--haiku-model <id>', 'Model for the Haiku tier and background tasks')
    .option('--env <NAME=VALUE>', 'Extra settings.json env entry, repeatable (cloud region, project, ...)', collect, [])
    .option('--api-key <key>', 'API key for the template (visible in shell history; prefer the options below)')
    .option('--api-key-env <NAME>', 'Read the API key from this environment variable')
    .option('--api-key-stdin', 'Read the API key from standard input')
    .option('--full', 'Create a full profile (settings plus instructions, agents, skills, ...)')
    .option('--include <paths>', `Comma-separated paths for a full profile (default: ${DEFAULT_MANAGED_PATHS.join(',')})`)
    .option('--verify', 'After --create, send a test request to the new endpoint')
    .option('--json', 'Machine-readable output for --list, --current, --show, --test and --providers');

  program.addHelpText(
    'after',
    `
Examples:
  cc-switch                                    interactive menu
  cc-switch work                               switch to profile "work"
  cc-switch --create kimi --template kimi      new profile for Moonshot Kimi (prompts for the key)
  cc-switch --create glm --template zai --api-key-env ZAI_API_KEY
  cc-switch --create local --template ollama --model qwen3.5
  cc-switch --create gw --template custom --base-url https://llm.example.com --model my-model
  cc-switch --providers                        list provider templates
  cc-switch --test                             check that the active profile works

Environment:
  CLAUDE_CONFIG_DIR   Claude Code config directory (default: ~/.claude)
  CC_SWITCH_HOME      cc-switch data directory (default: ~/.cc-switch)
  CC_SWITCH_API_KEY   API key used when no key option is given
  NO_COLOR            disable colored output`
  );

  // Let runCommandLine decide the exit code instead of commander calling process.exit itself.
  program.exitOverride();

  return program;
}

function parseEnvEntries(entries: string[]): Record<string, string> | undefined {
  if (entries.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    const name = separator > 0 ? entry.slice(0, separator).trim() : '';
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new UsageError(`--env expects NAME=VALUE (got "${entry}")`);
    }
    env[name] = entry.slice(separator + 1);
  }
  return env;
}

function parseManagedPaths(opts: CliOptions): string[] | undefined {
  if (!opts.full) return undefined;
  if (!opts.include) return [...DEFAULT_MANAGED_PATHS];

  const paths = opts.include.split(',').map(s => s.trim()).filter(Boolean);
  if (paths.length === 0) {
    throw new UsageError(`--include must specify at least one valid path.\nValid paths: ${VALID_MANAGED_PATH_NAMES.join(', ')}`);
  }
  const invalid = paths.filter(p => !VALID_MANAGED_PATH_NAMES.includes(p));
  if (invalid.length > 0) {
    throw new UsageError(`Invalid managed path(s): ${invalid.join(', ')}\nValid paths: ${VALID_MANAGED_PATH_NAMES.join(', ')}`);
  }
  return paths;
}

function modelOverridesFrom(opts: CliOptions): ModelOverrides | undefined {
  const models: ModelOverrides = {
    model: opts.model,
    opus: opts.opusModel,
    sonnet: opts.sonnetModel,
    haiku: opts.haikuModel,
  };
  return Object.values(models).some(Boolean) ? models : undefined;
}

function detectActions(opts: CliOptions): Action[] {
  const actions: Action[] = [];
  if (opts.switch) actions.push('switch');
  if (opts.create) actions.push('create');
  if (opts.delete) actions.push('delete');
  if (opts.rename || opts.to) actions.push('rename');
  if (opts.current) actions.push('current');
  if (opts.list) actions.push('list');
  if (opts.show !== undefined) actions.push('show');
  if (opts.test !== undefined) actions.push('test');
  if (opts.setKey) actions.push('set-key');
  if (opts.refresh) actions.push('refresh');
  if (opts.providers) actions.push('providers');
  return actions;
}

function assertModifiersAllowed(opts: CliOptions, action: Action | undefined): void {
  const createOnly: Array<[string, unknown]> = [
    ['--template', opts.template],
    ['--endpoint', opts.endpoint],
    ['--base-url', opts.baseUrl],
    ['--auth-style', opts.authStyle],
    ['--model', opts.model],
    ['--opus-model', opts.opusModel],
    ['--sonnet-model', opts.sonnetModel],
    ['--haiku-model', opts.haikuModel],
    ['--env', opts.env.length > 0],
    ['--full', opts.full],
    ['--include', opts.include],
    ['--verify', opts.verify],
  ];
  if (action !== 'create') {
    const used = createOnly.find(([, value]) => Boolean(value));
    if (used) throw new UsageError(`${used[0]} can only be used with --create.`);
  }

  const keyFlagUsed = opts.apiKey || opts.apiKeyEnv || opts.apiKeyStdin;
  if (keyFlagUsed && action !== 'create' && action !== 'set-key') {
    throw new UsageError('API key options can only be used with --create or --set-key.');
  }
  if (action === 'create' && keyFlagUsed && !opts.template) {
    throw new UsageError('API key options can only be used with --template.');
  }
  if (opts.json && !['current', 'list', 'show', 'test', 'providers'].includes(action ?? '')) {
    throw new UsageError('--json can only be used with --current, --list, --show, --test or --providers.');
  }
  if (opts.include && !opts.full) throw new UsageError('--include can only be used with --full.');
}

async function promptForApiKey(label: string, keyUrl?: string): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new UsageError(
      `An API key is required for ${label}. Provide it with --api-key-env <NAME>, --api-key-stdin, or the CC_SWITCH_API_KEY variable.`
    );
  }
  if (keyUrl) clack.log.info(`Create a key at ${keyUrl}`);
  const key = await clack.password({
    message: `API key for ${label}:`,
    validate: value => (!value || !value.trim() ? 'API key cannot be empty' : undefined),
  });
  if (clack.isCancel(key)) {
    clack.cancel('Operation cancelled');
    process.exit(0);
  }
  return key;
}

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) console.error(pc.yellow(`Warning: ${warning}`));
}

export function printSwitchResult(result: SwitchResult): void {
  console.log(`Switched to profile "${result.to}"`);
  if (result.cleared.length > 0) {
    console.log(pc.dim(`  Removed ${result.cleared.join(', ')} from the Claude config directory (still saved in profile "${result.from}")`));
  }
  printWarnings(result.warnings);
}

export function printCreateResult(result: CreateResult): void {
  const template = result.provider ? ` with template "${result.provider.id}"` : '';
  const full = result.type === 'full' ? ' (full profile)' : '';
  console.log(`Created profile "${result.name}"${template}${full}`);
  if (result.cleared.length > 0) {
    console.log(pc.dim(`  Removed ${result.cleared.join(', ')} from the Claude config directory (still saved in the previous profile)`));
  }
  for (const note of result.notes) console.log(pc.dim(`  ${note}`));
  if (result.summary.baseUrl && needsInsecureTransportWarning(result.summary.baseUrl)) {
    printWarnings([`${result.summary.baseUrl} is not HTTPS; your API key travels unencrypted.`]);
  }
}

export async function printTestResult(profileName: string, json = false): Promise<boolean> {
  const connection = await getProfileConnection(profileName);
  const result = await testConnection(connection);
  const good = result.status === 'ok' || result.status === 'reachable' || result.status === 'skipped';

  if (json) {
    console.log(JSON.stringify({ profile: profileName, ...result }, null, 2));
  } else {
    const label = result.status === 'ok' ? pc.green('OK') : good ? pc.yellow(result.status.toUpperCase()) : pc.red('FAILED');
    console.log(`${label}  ${profileName}: ${result.message}`);
  }
  return good;
}

async function runAction(action: Action, opts: CliOptions, profileArg: string | undefined): Promise<void> {
  switch (action) {
    case 'switch': {
      printSwitchResult(await switchProfile(opts.switch!));
      return;
    }

    case 'create': {
      const name = opts.create!;
      const managedPaths = parseManagedPaths(opts);
      const env = parseEnvEntries(opts.env);
      const provider = opts.template ? findProvider(opts.template) : undefined;
      if (opts.template && !provider) {
        throw new UsageError(`Unknown provider "${opts.template}". Run "cc-switch --providers" to list the available providers.`);
      }

      // Fail on a taken name before asking for a key.
      await assertCanCreate(name);
      // The CC_SWITCH_API_KEY fallback only applies when there is a template to give a key to.
      let apiKey = provider || hasExplicitApiKeySource(opts) ? await resolveApiKey(opts) : undefined;
      if (provider && providerNeedsKey(provider) && !apiKey && !provider.keyOptional) {
        apiKey = await promptForApiKey(provider.label, provider.endpoints.find(e => e.id === opts.endpoint)?.keyUrl ?? provider.keyUrl);
      }

      const result = await createProfile(name, {
        template: provider?.id,
        endpoint: opts.endpoint,
        baseUrl: opts.baseUrl,
        authStyle: opts.authStyle,
        models: modelOverridesFrom(opts),
        env,
        apiKey,
        full: opts.full,
        managedPaths,
      });
      printCreateResult(result);

      if (opts.verify) {
        const ok = await printTestResult(name);
        if (!ok) process.exitCode = 1;
      }
      return;
    }

    case 'delete': {
      await deleteProfile(opts.delete!);
      console.log(`Deleted profile "${opts.delete}"`);
      return;
    }

    case 'rename': {
      const renameArgs = opts.rename ?? [];
      if (!renameArgs.length && opts.to) throw new UsageError('Missing old profile name for --rename');
      if (!renameArgs.length) throw new UsageError('Missing profile name for --rename');
      if (renameArgs.length > 2) throw new UsageError('Provide only two names for --rename');
      if (renameArgs.length === 2 && opts.to) {
        throw new UsageError('Use either "--rename <old> <new>" or "--rename <old> --to <new>"');
      }

      const oldName = renameArgs[0]!;
      const newName = renameArgs.length === 2 ? renameArgs[1] : opts.to;
      if (!newName) throw new UsageError('Missing new profile name for --rename');

      await renameProfile(oldName, newName);
      console.log(oldName === newName ? 'Profile name unchanged' : `Renamed profile "${oldName}" to "${newName}"`);
      return;
    }

    case 'current': {
      const status = await getActiveProfileStatus();
      if (opts.json) {
        const details = status.exists ? await getProfileDetails(status.name) : undefined;
        console.log(JSON.stringify({ name: status.name, exists: status.exists, provider: details?.summary.providerId ?? null }, null, 2));
      } else {
        console.log(formatCurrentLine(status.name, status.exists));
      }
      return;
    }

    case 'list': {
      const [status, profiles] = await Promise.all([getActiveProfileStatus(), listProfiles()]);
      if (opts.json) {
        console.log(JSON.stringify({
          active: status.name,
          profiles: profiles.map(p => ({
            name: p.name,
            active: p.isActive,
            type: p.type,
            provider: p.summary.providerId ?? null,
            baseUrl: p.summary.baseUrl ?? null,
            models: p.summary.models,
          })),
        }, null, 2));
        return;
      }
      console.log(formatCurrentLine(status.name, status.exists));
      printProfileList(profiles);
      return;
    }

    case 'show': {
      const name = typeof opts.show === 'string' ? opts.show : (await getActiveProfileStatus()).name;
      const details = await getProfileDetails(name);
      if (opts.json) {
        console.log(JSON.stringify({
          name: details.name,
          active: details.isActive,
          type: details.type,
          managedPaths: details.managedPaths,
          provider: details.summary.providerId ?? null,
          baseUrl: details.summary.baseUrl ?? null,
          models: details.summary.models,
          credential: details.summary.credential ?? null,
          apiKey: details.summary.maskedKey ?? null,
          settingsPath: details.settingsPath,
        }, null, 2));
      } else {
        printProfileDetails(details);
      }
      return;
    }

    case 'test': {
      const name = typeof opts.test === 'string' ? opts.test : (await getActiveProfileStatus()).name;
      const ok = await printTestResult(name, opts.json);
      if (!ok) process.exitCode = 1;
      return;
    }

    case 'set-key': {
      const name = opts.setKey!;
      let apiKey = await resolveApiKey(opts);
      if (!apiKey) apiKey = await promptForApiKey(`profile "${name}"`);
      const { variable } = await setProfileApiKey(name, apiKey);
      console.log(`Updated ${variable} for profile "${name}"`);
      return;
    }

    case 'refresh': {
      const result = await refreshProfileFromTemplate(opts.refresh!);
      console.log(`Applied the latest ${result.provider.label} defaults to profile "${opts.refresh}"`);
      return;
    }

    case 'providers': {
      if (opts.json) {
        console.log(JSON.stringify(PROVIDERS.map(p => ({
          id: p.id,
          label: p.label,
          category: p.category,
          auth: p.auth,
          endpoints: p.endpoints.map(e => ({ id: e.id, baseUrl: e.baseUrl })),
          models: p.models ?? null,
          requiresModel: Boolean(p.requiresModel),
          docs: p.docsUrl,
        })), null, 2));
      } else {
        printProviders(PROVIDERS);
      }
      return;
    }
  }
}

/**
 * Run the command line. Returns false when no arguments were supplied and the caller should
 * start interactive mode instead.
 */
export async function runCommandLine(argv: string[]): Promise<boolean> {
  if (argv.length === 0) return false;

  const program = buildProgram();

  if (argv.length === 1 && argv[0] === 'help') {
    program.outputHelp();
    return true;
  }
  if (argv.length === 1 && argv[0] === 'version') {
    console.log(cliVersion);
    return true;
  }

  try {
    program.parse(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander has already printed help, the version or its error message.
      process.exitCode = error.exitCode;
      return true;
    }
    throw error;
  }

  const opts = program.opts<CliOptions>();
  const profileArg = program.args[0];

  try {
    const actions = detectActions(opts);
    if (actions.length > 1) throw new UsageError('Please provide only one action flag at a time.');
    if (profileArg && actions.length > 0) throw new UsageError('Do not combine a profile name with action flags.');
    if (program.args.length > 1) throw new UsageError(`Unexpected extra arguments: ${program.args.slice(1).join(' ')}`);

    const action = actions[0];
    assertModifiersAllowed(opts, action);

    if (!action) {
      if (!profileArg) {
        program.outputHelp();
        return true;
      }
      printSwitchResult(await switchProfile(profileArg));
      return true;
    }

    await runAction(action, opts, profileArg);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
  return true;
}
