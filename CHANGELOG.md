# Changelog

## 4.0.0

**Breaking:** requires Node.js 22.12 or newer (Node 20 is end-of-life). `--list` prints a table; use `--list --json` in scripts.

### Added
- 40+ provider templates written from each provider's own Claude Code docs, with regional and plan variants (`--endpoint`). v3 template names still work.
- Guided interactive create and edit: searchable providers, hidden key entry, model choice, review, optional live test.
- Commands `--show`, `--test`, `--set-key`, `--refresh`, `--providers`, plus `--verify`, `--json`, `--model`, `--opus-model`, `--sonnet-model`, `--haiku-model`, `--env`, `--base-url`, `--auth-style`.
- Safer key input: `--api-key-env`, `--api-key-stdin`, `CC_SWITCH_API_KEY`, hidden prompt.
- Full profiles can manage `rules`, `commands`, `output-styles`, `workflows` and `keybindings` (defaults now include `rules` and `commands`).
- Honors `CLAUDE_CONFIG_DIR`; `CC_SWITCH_HOME` relocates cc-switch's data.

### Fixed
- A failed or interrupted switch or create now restores the previous profile; before, a retry could overwrite its saved settings.
- A new profile can no longer take the active profile's name (including the implicit `default`), which overwrote your original settings.
- Creating a profile now moves managed paths like a switch, so edits are not silently discarded later.
- Applying a template no longer removes values you own; the `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` opt-out is never removed.
- Creating a profile now always saves the profile you were using (v3 only did with a template).
- The state file is written atomically (v3 wrote a temp file but never renamed it).

### Security
- Settings, state and profile files are written `0600` (directories `0700`); symlinked settings files are updated in place.
- The connection test never follows redirects, redacts keys, and strips terminal control characters from server text.
- Base URLs are validated; `--env` cannot set the endpoint or credentials; corrupt `state.json` is rejected.

### Tooling
- TypeScript 7, tsup 9, commander 15, @clack/prompts 1.8; vitest and picocolors added. `pnpm audit` is clean (v3 had 2 high and 1 moderate advisories in build tooling).
- 136 tests; CI on Linux, macOS and Windows (Node 22 and 24); weekly audit; Dependabot; npm provenance.

## 3.2.0 and earlier

See the git history.
