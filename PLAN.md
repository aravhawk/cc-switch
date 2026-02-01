# cc-switch Plan

## Summary
Build a terminal-based CLI that manages multiple Claude Code profiles by copying and swapping `~/.claude/settings.json` with per-profile stored copies in `~/.cc-switch/profiles`. Supports create, delete, switch, rename, and list. New profiles clone from the currently active settings.

## Goals
- Allow multiple profiles for Claude Code via `settings.json`.
- Store profiles at `~/.cc-switch/profiles/<profile>/settings.json`.
- Switch operation mirrors current active settings into its profile store before replacing `~/.claude/settings.json`.
- Provide interactive terminal UI plus non-interactive commands.
- Publishable to npm.

## Non-goals
- No GUI application.
- No cloud sync.
- No changes to Claude Code itself.

## Constraints and preferences
- CLI built with Node + TypeScript, using `pnpm`.
- This is a CLI, so do not use Next.js (intentional exception to general preference).
- Avoid non-ASCII characters unless already present.
- Keep `.gitignore` up to date with `.DS_Store`, `__pycache__`, `.idea`.
- Keep `CLAUDE.md` and/or `AGENTS.md` updated with learned project details and rules.
- If any requirements file exists, keep it updated.

## CLI commands
- `cc-switch` (no args): interactive menu (list, switch, create, delete, rename).
- `cc-switch switch <name>`
- `cc-switch create <name>`
- `cc-switch delete <name>`
- `cc-switch rename <old> <new>`
- `cc-switch list`

## Data layout
- `~/.cc-switch/`
  - `profiles/<name>/settings.json`
  - `state.json`

### state.json schema
```
{
  "activeProfile": "default",
  "lastSyncedAt": "2026-02-01T12:34:56.789Z"
}
```

## Core workflows

### Switch
1. Resolve `activeProfile` from `state.json` (if missing, default to `default`).
2. Validate target profile exists.
3. Mirror current `~/.claude/settings.json` into `~/.cc-switch/profiles/<activeProfile>/settings.json`.
4. Replace `~/.claude/settings.json` with the target profile's `settings.json`.
5. Update `state.json` with the new active profile and timestamp.
6. If target equals active, still mirror and then exit with "Already active" message.

### Create
1. Validate name (no empty string, no path traversal, no existing profile).
2. Ensure `~/.claude/settings.json` exists.
3. Copy `~/.claude/settings.json` into `~/.cc-switch/profiles/<name>/settings.json`.
4. Do not change active profile.

### Delete
1. Block deletion if target is active (require switching first).
2. Confirm delete in interactive mode.
3. Remove `~/.cc-switch/profiles/<name>` directory.

### Rename
1. Validate `new` name (no empty string, no path traversal, not existing).
2. Rename directory `profiles/<old>` to `profiles/<new>`.
3. If `old` is active, update `state.json` to `new`.
4. Preserve settings content as-is.

### List
- Show all profile names.
- Mark active profile.

## Validation rules
- Profile name must be non-empty and must not contain `..`, `/`, `\`, or path separators.
- Optional: restrict to `[A-Za-z0-9-_]+` for safety and clarity.

## Missing settings behavior
If `~/.claude/settings.json` does not exist:
- Print: `No ~/.claude/settings.json found. Run Claude Code once to generate it, or run the setup script provided by your provider (e.g., Z.ai).`
- Abort without creating profiles.

## Error handling
- Clear, actionable messages for:
  - Missing profile on switch.
  - Missing settings file.
  - Permission errors.
  - Invalid profile names.
- Exit codes:
  - `0` on success.
  - `1` on validation or filesystem errors.

## Implementation details
- Use `os.homedir()` + `path.join()` for paths.
- Use `fs/promises` with atomic writes (write temp file then rename).
- Use a prompt library for interactive UX (e.g., `@clack/prompts`).
- Use a CLI parser (e.g., `commander`) for args.
- Ensure compiled CLI has a shebang and is executable.
- Target Node 18+.

## Packaging for npm
- `package.json`:
  - `name`: `cc-switch`
  - `bin`: `{"cc-switch": "dist/index.js"}`
  - `files`: include `dist`, `README.md`, `LICENSE`.
- Build with `tsup` or `esbuild` to `dist/`.

## Docs
- `README.md`:
  - Install and usage examples.
  - Command reference.
  - Data layout.
  - Error message for missing settings.
- Update `CLAUDE.md` and/or `AGENTS.md` with:
  - CLI behavior details.
  - Profile storage paths.
  - Validation rules.

## Verification checklist
- Create profile from active settings.
- Switch profiles and verify mirror-backup behavior.
- Rename a profile and ensure active state updates.
- Delete a non-active profile.
- Validate missing settings error message.
- Check interactive flow works in macOS Terminal.
