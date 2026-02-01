import { Command } from 'commander';
import * as clack from '@clack/prompts';
import { listProfiles, switchProfile, createProfile, deleteProfile, renameProfile } from './profiles.js';

const program = new Command();

program
  .name('cc-switch')
  .description('Profile manager for Claude Code settings')
  .version('1.0.0');

program
  .command('switch <name>')
  .description('Switch to a different profile')
  .action(async (name: string) => {
    try {
      await switchProfile(name);
      console.log(`Switched to profile "${name}"`);
      process.exit(0);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('create <name>')
  .description('Create a new profile from current settings')
  .action(async (name: string) => {
    try {
      await createProfile(name);
      console.log(`Created profile "${name}"`);
      process.exit(0);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('delete <name>')
  .description('Delete a profile')
  .action(async (name: string) => {
    try {
      await deleteProfile(name);
      console.log(`Deleted profile "${name}"`);
      process.exit(0);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('rename <oldName> <newName>')
  .description('Rename a profile')
  .action(async (oldName: string, newName: string) => {
    try {
      await renameProfile(oldName, newName);
      console.log(`Renamed profile "${oldName}" to "${newName}"`);
      process.exit(0);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List all profiles')
  .action(async () => {
    try {
      const profiles = await listProfiles();

      if (profiles.length === 0) {
        console.log('No profiles found');
        process.exit(0);
      }

      console.log('\nProfiles:');
      for (const profile of profiles) {
        const marker = profile.isActive ? ' (active)' : '';
        console.log(`  ${profile.name}${marker}`);
      }
      console.log();
      process.exit(0);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

// Interactive mode (no args)
async function interactiveMode() {
  clack.intro('cc-switch - Claude Code Profile Manager');

  try {
    const profiles = await listProfiles();

    if (profiles.length === 0) {
      clack.outro('No profiles found. Create one with: cc-switch create <name>');
      process.exit(0);
    }

    const action = await clack.select({
      message: 'What would you like to do?',
      options: [
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

      case 'create': {
        const profileName = await clack.text({
          message: 'Enter new profile name:',
          validate: (value) => {
            if (!value) return 'Profile name is required';
            if (!/^[A-Za-z0-9-_]+$/.test(value)) {
              return 'Profile name can only contain letters, numbers, hyphens, and underscores';
            }
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
            if (!value) return 'Profile name is required';
            if (!/^[A-Za-z0-9-_]+$/.test(value)) {
              return 'Profile name can only contain letters, numbers, hyphens, and underscores';
            }
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
        console.log('\nProfiles:');
        for (const profile of profiles) {
          const marker = profile.isActive ? ' (active)' : '';
          console.log(`  ${profile.name}${marker}`);
        }
        console.log();
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

// Parse arguments and determine mode
program.parse();

// If no command was provided, run interactive mode
if (!process.argv.slice(2).length) {
  interactiveMode();
}
