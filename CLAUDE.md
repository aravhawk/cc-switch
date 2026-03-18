# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Install dependencies
pnpm install

# Build the CLI (compiles src/ to dist/)
pnpm build

# Watch mode for development
pnpm dev

# Type checking without emitting files
pnpm typecheck

# Test the CLI locally (after building)
node dist/index.js [command]
./dist/index.js [command]

# Install globally for testing
pnpm link --global

# Publish to npm
pnpm publish --access public

# Release helpers (bump + push tag)
pnpm release:patch
pnpm release:minor
pnpm release:major
```

## Architecture Overview

This is a TypeScript CLI tool that manages multiple Claude Code configuration profiles. It supports two profile types:
- **Settings-only profiles**: Swap only `~/.claude/settings.json` (the default)
- **Full profiles**: Swap settings.json plus user-selected paths (CLAUDE.md, agents/, skills/, plugins/, teams/) for complete per-provider environments

### Module Structure

The codebase follows a clear separation of concerns:

- **index.ts**: CLI entry point that orchestrates command parsing (commander) and interactive UI (@clack/prompts). Uses long flags for actions (create/delete/rename/current/list/switch), supports `cc-switch <profile>` as the shorthand switch, and reserves `help` and `version`.
- **profiles.ts**: Core business logic for all profile operations (switch, create, delete, rename, list). Each operation enforces validation rules and uses atomic file operations.
- **state.ts**: Manages the global state file (`~/.cc-switch/state.json`) that tracks which profile is currently active. Provides read/write/update functions with atomic writes.
- **paths.ts**: Centralized path construction for all filesystem locations. Single source of truth for `~/.claude/settings.json`, `~/.cc-switch/` paths, and the `AVAILABLE_MANAGED_PATHS` / `DEFAULT_MANAGED_PATHS` constants that define which `~/.claude` paths can be included in full profiles.
- **validation.ts**: Profile name validation logic. Enforces security rules to prevent path traversal attacks.
- **types.ts**: TypeScript interfaces for State, ProfileInfo, ProfileMeta, ProfileType, etc.

### Critical Workflow: Profile Switching

The switch operation has a specific order of operations that must be preserved:

1. **Mirror-then-replace**: Always save the current active profile's state BEFORE loading the target profile. For full profiles, this includes mirroring managed paths (CLAUDE.md, agents/, skills/, etc.) in addition to settings.json.
2. **Atomic writes**: Use temp file + rename pattern to prevent corruption (for single files; directory copies use `fs.cp` with `verbatimSymlinks: true`)
3. **Load target**: After mirroring, load target's settings.json. If target is a full profile, also load its managed paths into `~/.claude`.
4. **State update**: Only update state.json after all file operations succeed

This design ensures users never lose their current settings, even if the switch operation is interrupted.

### Data Layout

User data is stored outside this repository at:
- `~/.cc-switch/profiles/<name>/settings.json` - Per-profile Claude settings (always present)
- `~/.cc-switch/profiles/<name>/profile.json` - Profile metadata for full profiles (`{"type":"full","version":1,"managedPaths":[...]}`)
- `~/.cc-switch/profiles/<name>/CLAUDE.md` - Full profiles only, if in managedPaths
- `~/.cc-switch/profiles/<name>/agents/` - Full profiles only, if in managedPaths
- `~/.cc-switch/profiles/<name>/skills/` - Full profiles only, if in managedPaths
- `~/.cc-switch/profiles/<name>/plugins/` - Full profiles only, if in managedPaths
- `~/.cc-switch/profiles/<name>/teams/` - Full profiles only, if in managedPaths
- `~/.cc-switch/state.json` - Active profile tracker

The tool operates on `~/.claude/settings.json` (Claude Code's live config) and, for full profiles, also on `~/.claude/CLAUDE.md`, `~/.claude/agents/`, `~/.claude/skills/`, etc.

## Build System

Uses `tsup` to compile TypeScript to ESM format:
- **Entry**: `src/index.ts`
- **Output**: `dist/index.js` (with shebang for CLI execution)
- **Target**: Node 20.7+
- **Format**: ESM only (note the `.js` extensions in imports)

The shebang (`#!/usr/bin/env node`) is added by tsup config, NOT in source files. Source file `index.ts` should not contain a shebang.

## Constraints

- **No Next.js**: This is a CLI tool, intentionally does not use Next.js despite user's general preference
- **No GUI**: Terminal-only interface
- **No cloud sync**: Local filesystem only
- **Package manager**: Use `pnpm` exclusively
- **Node version**: Requires Node 20.7+ (for `fs.cp` `verbatimSymlinks` support)
- **No non-ASCII**: Avoid emojis and special characters in code/output

## Key Implementation Rules

### Profile Name Validation
Profile names must match `^[A-Za-z0-9-_]+$` and must not be `help` or `version` (case-insensitive) to prevent path traversal and CLI conflicts. This is enforced in `validation.ts` and should never be relaxed.

### Atomic File Operations
All file writes must use the temp-file-then-rename pattern:
```typescript
const tempFile = `${targetPath}.tmp`;
await writeFile(tempFile, content);
await rename(tempFile, targetPath);
```

### Error Messages
When `~/.claude/settings.json` is missing, show this exact message:
```
No ~/.claude/settings.json found. Run Claude Code once to generate it, or run the setup script provided by your provider (e.g., Z.ai).
```

### Active Profile Protection
Cannot delete the active profile. Users must switch to another profile first. This prevents accidentally deleting their current working configuration.

### Rename Behavior
Renaming a profile to the same name is a no-op. The CLI should exit successfully and report that the profile name is unchanged.

## Testing Locally

Since there are no automated tests, manually verify changes:

```bash
# Build first
pnpm build

# Create settings-only profile
node dist/index.js --create test-profile

# Create full profile (default managed paths: CLAUDE.md, agents, skills)
node dist/index.js --create test-full --full

# Create full profile with custom paths
node dist/index.js --create test-custom --full --include CLAUDE.md,skills

# List profiles (should show type markers)
node dist/index.js --list

# Show current profile
node dist/index.js --current

# Switch between profiles
node dist/index.js --switch test-profile
node dist/index.js --switch test-full

# Shorthand switch
node dist/index.js test-profile

# Rename it
node dist/index.js --rename test-profile renamed

# Create another to switch back
node dist/index.js --create another
node dist/index.js --switch another

# Delete profiles
node dist/index.js --delete renamed
node dist/index.js --delete test-full
node dist/index.js --delete test-custom

# Clean up
rm -rf ~/.cc-switch
```

## Publishing Checklist

Before publishing to npm:
1. Update version in `package.json`
2. Run `pnpm build` and verify `dist/index.js` has shebang
3. Test CLI locally with `node dist/index.js`
4. Verify `package.json` files field includes only dist/, README.md, LICENSE
5. Run `pnpm publish --access public` (must be logged into npm)

## CI Publishing (GitHub Actions)

- Trigger: Release `published`
- Workflow: `.github/workflows/publish.yml` (publishes with `--access public`)
- Secret: `NPM_TOKEN` with publish access and 2FA bypass
