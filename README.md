# cc-switch

Profile manager for Claude Code settings. Easily manage and switch between multiple Claude Code configurations.

## Installation

```bash
npm install -g @aravhawk/cc-switch
```

Or with pnpm:

```bash
pnpm add -g @aravhawk/cc-switch
```

## Usage

### Interactive Mode

Run `cc-switch` without arguments to enter interactive mode:

```bash
cc-switch
```

This will present a menu with options to:
- Show the current profile
- Switch between profiles
- Create new profiles
- Delete profiles
- Rename profiles
- List all profiles

### Command Line Mode

Actions use flags. Use a positional profile name for quick switching.

#### Switch Profile

```bash
cc-switch <profile-name>
```

Or explicit:
```bash
cc-switch --switch <profile-name>
```

Example:
```bash
cc-switch work
```

#### Create Profile

Create a new profile from your current `~/.claude/settings.json`:

```bash
cc-switch --create <profile-name>
```

Example:
```bash
cc-switch --create personal
```

#### Delete Profile

Delete an existing profile (cannot delete the active profile):

```bash
cc-switch --delete <profile-name>
```

Example:
```bash
cc-switch --delete old-config
```

#### Rename Profile

Rename an existing profile:

```bash
cc-switch --rename <old-name> <new-name>
```

Or:
```bash
cc-switch --rename <old-name> --to <new-name>
```

Example:
```bash
cc-switch --rename work work-2024
```

#### List Profiles

List all available profiles:

```bash
cc-switch --list
```

#### Current Profile

Show the active profile:

```bash
cc-switch --current
```

#### Help and Version

```bash
cc-switch help
cc-switch --help
cc-switch version
cc-switch --version
```

Reserved profile names: `help` and `version`.

## How It Works

`cc-switch` manages multiple Claude Code profiles by storing copies of your `settings.json` file in separate profile directories.

### Data Layout

```
~/.cc-switch/
├── profiles/
│   ├── default/
│   │   └── settings.json
│   ├── work/
│   │   └── settings.json
│   └── personal/
│       └── settings.json
└── state.json
```

### State File

The `state.json` file tracks the currently active profile:

```json
{
  "activeProfile": "default",
  "lastSyncedAt": "2026-02-01T12:34:56.789Z"
}
```

### Switch Behavior

When you switch profiles:

1. The current `~/.claude/settings.json` is mirrored back to the active profile's directory
2. The target profile's `settings.json` is copied to `~/.claude/settings.json`
3. The active profile is updated in `state.json`

This ensures you never lose your current settings when switching.

## Requirements

- Node.js 18 or higher
- Claude Code installed (with `~/.claude/settings.json` present)

## First-Time Setup

If you don't have a `~/.claude/settings.json` file, you'll see this error:

```
No ~/.claude/settings.json found. Run Claude Code once to generate it,
or run the setup script provided by your provider (e.g., Z.ai).
```

Simply run Claude Code once to generate the initial settings file, then you can start using `cc-switch`.

## Profile Name Rules

Profile names must:
- Not be empty
- Only contain letters, numbers, hyphens, and underscores
- Not contain path separators (`/`, `\`, `..`)
- Not be reserved words (`help`, `version`)

## Error Handling

`cc-switch` provides clear error messages for common issues:

- Missing Claude settings file
- Profile not found
- Attempting to delete the active profile
- Invalid profile names
- Permission errors

All operations use atomic file writes to prevent data loss.

## License

[MIT](LICENSE)
