import { Command } from 'commander';
import * as clack from '@clack/prompts';
import { createRequire } from 'module';
import {
  listProfiles,
  switchProfile,
  createProfile,
  deleteProfile,
  renameProfile,
  getActiveProfileStatus,
} from './profiles.js';
import { validateProfileName } from './validation.js';
import type { ActiveProfileStatus } from './types.js';

const require = createRequire(import.meta.url);

function getCliVersion(): string {
  try {
    const pkg = require('../package.json') as { version?: string };
    if (pkg && typeof pkg.version === 'string') {
      return pkg.version;
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

const cliVersion = getCliVersion();
const program = new Command();

function formatActiveProfileLine(status: ActiveProfileStatus): string {
  const missingSuffix = status.exists ? '' : ' (missing)';
  return `Current profile: "${status.name}"${missingSuffix}`;
}

function getProfileValidationMessage(value?: string): string | undefined {
  const validation = validateProfileName(value ?? '');
  if (!validation.valid) {
    return validation.error ?? 'Profile name is invalid';
  }
  return undefined;
}

async function showProfileList(
  profiles?: Awaited<ReturnType<typeof listProfiles>>
): Promise<void> {
  const activeStatus = await getActiveProfileStatus();
  const resolvedProfiles = profiles ?? await listProfiles();

  console.log(formatActiveProfileLine(activeStatus));

  if (resolvedProfiles.length === 0) {
    console.log('No profiles found');
    return;
  }

  console.log('\nProfiles:');
  for (const profile of resolvedProfiles) {
    const marker = profile.isActive ? ' (active)' : '';
    console.log(`  ${profile.name}${marker}`);
  }
  console.log();
}

program
  .name('cc-switch')
  .description('Profile manager for Claude Code settings')
  .version(cliVersion, '-V, --version', 'output the version number')
  .argument('[profile]', 'Profile name to switch to')
  .option('--switch <name>', 'Switch to a different profile')
  .option('--create <name>', 'Create a new profile from current settings')
  .option('--delete <name>', 'Delete a profile')
  .option('--rename <names...>', 'Rename a profile')
  .option('--to <name>', 'New name for rename')
  .option('--current', 'Show the current active profile')
  .option('--list', 'List all profiles');

// Interactive mode (no args)
async function interactiveMode() {
  clack.intro('cc-switch - Claude Code Profile Manager');

  try {
    const profiles = await listProfiles();

    if (profiles.length === 0) {
      clack.outro('No profiles found. Create one with: cc-switch --create <name>');
      process.exit(0);
    }

    const action = await clack.select({
      message: 'What would you like to do?',
      options: [
        { value: 'current', label: 'Show current profile' },
        { value: 'switch', label: 'Switch profile' },
        { value: 'create', label: 'Create new profile' },
        { value: 'delete', label: 'Delete profile' },
        { value: 'rename', label: 'Rename profile' },
        { value: 'list', label: 'List profiles' },
      ],
    });

    if (clack.isCancel(action)) {
      clack.cancel('Operation cancelled');
      process.exit(0);
    }

    switch (action) {
      case 'switch': {
        const profileChoices = profiles.map(p => ({
          value: p.name,
          label: p.isActive ? `${p.name} (active)` : p.name,
        }));

        const selectedProfile = await clack.select({
          message: 'Select profile to switch to:',
          options: profileChoices,
        });

        if (clack.isCancel(selectedProfile)) {
          clack.cancel('Operation cancelled');
          process.exit(0);
        }

        await switchProfile(selectedProfile as string);
        clack.outro(`Switched to profile "${selectedProfile}"`);
        break;
      }

      case 'current': {
        const activeStatus = await getActiveProfileStatus();
        clack.outro(formatActiveProfileLine(activeStatus));
        break;
      }

      case 'create': {
        const profileName = await clack.text({
          message: 'Enter new profile name:',
          validate: (value) => {
            return getProfileValidationMessage(value);
          },
        });

        if (clack.isCancel(profileName)) {
          clack.cancel('Operation cancelled');
          process.exit(0);
        }

        await createProfile(profileName as string);
        clack.outro(`Created profile "${profileName}"`);
        break;
      }

      case 'delete': {
        const nonActiveProfiles = profiles.filter(p => !p.isActive);

        if (nonActiveProfiles.length === 0) {
          clack.outro('No profiles available to delete. Cannot delete the active profile.');
          process.exit(0);
        }

        const profileChoices = nonActiveProfiles.map(p => ({
          value: p.name,
          label: p.name,
        }));

        const selectedProfile = await clack.select({
          message: 'Select profile to delete:',
          options: profileChoices,
        });

        if (clack.isCancel(selectedProfile)) {
          clack.cancel('Operation cancelled');
          process.exit(0);
        }

        const confirmDelete = await clack.confirm({
          message: `Are you sure you want to delete profile "${selectedProfile}"?`,
        });

        if (clack.isCancel(confirmDelete)) {
          clack.cancel('Operation cancelled');
          process.exit(0);
        }

        if (!confirmDelete) {
          clack.outro('Deletion cancelled');
          process.exit(0);
        }

        await deleteProfile(selectedProfile as string);
        clack.outro(`Deleted profile "${selectedProfile}"`);
        break;
      }

      case 'rename': {
        const profileChoices = profiles.map(p => ({
          value: p.name,
          label: p.isActive ? `${p.name} (active)` : p.name,
        }));

        const oldName = await clack.select({
          message: 'Select profile to rename:',
          options: profileChoices,
        });

        if (clack.isCancel(oldName)) {
          clack.cancel('Operation cancelled');
          process.exit(0);
        }

        const newName = await clack.text({
          message: 'Enter new profile name:',
          validate: (value) => {
            return getProfileValidationMessage(value);
          },
        });

        if (clack.isCancel(newName)) {
          clack.cancel('Operation cancelled');
          process.exit(0);
        }

        await renameProfile(oldName as string, newName as string);
        clack.outro(`Renamed profile "${oldName}" to "${newName}"`);
        break;
      }

      case 'list': {
        await showProfileList(profiles);
        clack.outro('Profile list complete');
        break;
      }
    }

    process.exit(0);
  } catch (error: any) {
    clack.outro(`Error: ${error.message}`);
    process.exit(1);
  }
}

async function runCli(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (!rawArgs.length) {
    await interactiveMode();
    return;
  }

  if (rawArgs.length === 1) {
    const singleArg = rawArgs[0];
    if (singleArg === 'help') {
      program.outputHelp();
      return;
    }
    if (singleArg === 'version') {
      console.log(cliVersion);
      return;
    }
  }

  program.parse();

  const opts = program.opts<{
    switch?: string;
    create?: string;
    delete?: string;
    rename?: string[];
    to?: string;
    current?: boolean;
    list?: boolean;
  }>();

  const profileArg = program.args[0] as string | undefined;
  const actionFlags: string[] = [];

  if (opts.switch) actionFlags.push('switch');
  if (opts.create) actionFlags.push('create');
  if (opts.delete) actionFlags.push('delete');
  if (opts.rename || opts.to) actionFlags.push('rename');
  if (opts.current) actionFlags.push('current');
  if (opts.list) actionFlags.push('list');

  if (actionFlags.length > 1) {
    console.error('Error: Please provide only one action flag at a time.');
    process.exit(1);
  }

  if (profileArg && actionFlags.length > 0) {
    console.error('Error: Do not combine a profile name with action flags.');
    process.exit(1);
  }

  if (actionFlags.length === 0) {
    if (!profileArg) {
      program.outputHelp();
      process.exit(0);
      return;
    }

    try {
      await switchProfile(profileArg);
      console.log(`Switched to profile "${profileArg}"`);
      process.exit(0);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
    return;
  }

  const action = actionFlags[0];

  try {
    switch (action) {
      case 'switch': {
        if (!opts.switch) {
          throw new Error('Missing profile name for --switch');
        }
        await switchProfile(opts.switch);
        console.log(`Switched to profile "${opts.switch}"`);
        process.exit(0);
        break;
      }

      case 'create': {
        if (!opts.create) {
          throw new Error('Missing profile name for --create');
        }
        await createProfile(opts.create);
        console.log(`Created profile "${opts.create}"`);
        process.exit(0);
        break;
      }

      case 'delete': {
        if (!opts.delete) {
          throw new Error('Missing profile name for --delete');
        }
        await deleteProfile(opts.delete);
        console.log(`Deleted profile "${opts.delete}"`);
        process.exit(0);
        break;
      }

      case 'rename': {
        const renameArgs = opts.rename ?? [];
        const renameTarget = opts.to;

        if (!renameArgs.length && renameTarget) {
          throw new Error('Missing old profile name for --rename');
        }
        if (!renameArgs.length) {
          throw new Error('Missing profile name for --rename');
        }
        if (renameArgs.length > 2) {
          throw new Error('Provide only two names for --rename');
        }
        if (renameArgs.length === 2 && renameTarget) {
          throw new Error('Use either "--rename <old> <new>" or "--rename <old> --to <new>"');
        }

        const oldName = renameArgs[0];
        const newName = renameArgs.length === 2 ? renameArgs[1] : renameTarget;

        if (!newName) {
          throw new Error('Missing new profile name for --rename');
        }

        await renameProfile(oldName, newName);
        console.log(`Renamed profile "${oldName}" to "${newName}"`);
        process.exit(0);
        break;
      }

      case 'current': {
        const activeStatus = await getActiveProfileStatus();
        console.log(formatActiveProfileLine(activeStatus));
        process.exit(0);
        break;
      }

      case 'list': {
        await showProfileList();
        process.exit(0);
        break;
      }
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

void runCli();
