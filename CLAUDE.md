# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
pnpm install          # install (pnpm only)
pnpm build            # compile src/ to dist/ with tsup
pnpm dev              # watch mode
pnpm typecheck        # tsc --noEmit (TypeScript 7)
pnpm test             # vitest run
pnpm check            # typecheck + test + build (CI runs it before publishing)
pnpm audit            # dependency advisories; must stay clean

node dist/index.js [command]   # run the built CLI
pnpm link --global             # install globally for manual testing

pnpm release:patch|minor|major # bump, push tag, create GitHub release (CI publishes to npm)
```

## Architecture Overview

A TypeScript CLI that swaps Claude Code configuration profiles. Settings-only profiles swap `~/.claude/settings.json`; full profiles also swap chosen paths (CLAUDE.md, agents/, skills/, ...). Profiles are usually created from a provider template that writes the `env` block Claude Code needs for that endpoint. User-facing behavior is documented in README.md.

### Module Structure (`src/`)

- **index.ts**: entry. Runs the command line; with no arguments starts interactive mode.
- **cli.ts**: commander definition and non-interactive handlers. Action flags (`--create`, `--switch`, ...) plus `cc-switch <profile>` shorthand; `help` and `version` are reserved words. Exit codes are set via `process.exitCode`, not `process.exit` (commander uses `exitOverride`).
- **interactive.ts**: @clack/prompts flows (menu, guided create with searchable provider picker, edit, test, delete, rename). Requires a TTY.
- **profiles.ts**: all profile operations (list, switch, create, delete, rename, edit key/models, refresh, connection details). The only module that orchestrates file changes.
- **settings.ts**: pure functions over a settings.json object (`applyProvider`, `clearProvider`, `replaceCredential`, `replaceModels`, `summarizeSettings`, `maskSecret`) and the env ownership lists.
- **providers/**: `types.ts` (Provider, ProviderEndpoint, ModelSet, ...), `catalog.ts` (the data), `index.ts` (lookup, `resolveSelection`, `detectProvider`, and the built-in `custom` provider).
- **connection-test.ts**: one-request probe of a profile's endpoint (`--test`, `--verify`), plus `validateBaseUrl`.
- **api-key.ts**: API key input sources (`--api-key-env`, `--api-key-stdin`, `CC_SWITCH_API_KEY`, `--api-key`).
- **paths.ts**: all filesystem locations, resolved lazily (honors `CLAUDE_CONFIG_DIR` and `CC_SWITCH_HOME`); managed path definitions.
- **fs-utils.ts**: `atomicWrite` (private mode, symlink aware, unique temp file) and helpers.
- **state.ts**, **validation.ts**, **types.ts**, **ui.ts** (colors and table formatting via picocolors).

### Critical Workflow: Profile Switching

Order of operations must be preserved (`switchProfile` in profiles.ts):

1. **Validate first**: target exists, is not active, has a readable settings.json. Nothing is written before this passes.
2. **Mirror-then-replace**: save the outgoing profile (live settings.json plus its managed paths) BEFORE loading the target.
3. **Load target**: write settings.json, then apply the managed-path transition (`planManagedTransition`): load the target's paths, remove paths the outgoing profile owned but the target does not. A path missing from the target's store is removed only if the outgoing profile owned it; files the outgoing profile never managed are never touched.
4. **State update last**: `state.json` changes only after every file operation succeeded. If step 3 fails, the outgoing profile's live settings and managed paths are restored; otherwise the next mirror would overwrite the outgoing profile's saved copy with the target's. A test with fault injection (`test/switch-failure.test.ts`) guards this.

`createProfile` follows the same discipline: it refuses the active profile's name (even the implicit `default` that has no directory yet), mirrors the outgoing profile first (always), removes managed paths the new profile does not manage exactly like a switch would, and rolls back the new profile directory, live settings and managed paths if anything fails. `--show`/`--test`/`--set-key` accept the active profile even before it has a stored copy.

### Provider catalog rules (`src/providers/catalog.ts`)

- Every entry must be written from the provider's **own** Claude Code / Anthropic-compatibility documentation, and link it in `docsUrl`. Do not add providers or URLs from memory or community blog posts. Do not invent key-page URLs: omit `keyUrl` when unverified.
- `ANTHROPIC_BASE_URL` never ends in `/v1`. Only loopback hosts may use plain `http://`.
- Env ownership (settings.ts): `PROVIDER_ENV_KEYS` are always cleared when a provider is applied (endpoint, credentials, model mappings, anything sized for one model, cloud switches). Other keys a template sets (timeouts, tool search, region/project fields) are cleared only when the provider *currently configured* set them (derived from the catalog via `detectProvider`), so values the user added survive. `USER_OWNED_ENV_KEYS` (the telemetry opt-out `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) are never removed. A pairwise test (`providers.test.ts`) proves that applying A then B equals applying B directly; if you add a key that is sized for one model, add it to `PROVIDER_ENV_KEYS`.
- `--env` may not carry the endpoint or credentials (`ANTHROPIC_BASE_URL`, tokens, keys); those have validated paths.
- Model IDs go stale quickly. When changing defaults, re-read the provider's current docs. Providers that host many models set `requiresModel` instead of guessing.
- Auth styles: `token` (ANTHROPIC_AUTH_TOKEN), `api-key` (ANTHROPIC_API_KEY), `both`, `none` (local, writes a placeholder token), `native` (Anthropic/Bedrock/Vertex/Foundry; no base URL or key).
- Legacy v3 template names (`anthropic`, `claude`, `moonshot`, `kimi`, `zai`, `glm`, `minimax`) must keep resolving. `moonshot` and `kimi` mean Kimi Code.
- Add new providers to the README table; a test fails if one is missing.

### Data Layout

`~/.cc-switch/state.json` and `~/.cc-switch/profiles/<name>/{settings.json, profile.json, <managed paths>}` (see README). The tool operates on `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`, and the managed paths beside it.

## Build System

`tsup` compiles `src/index.ts` to ESM `dist/index.js` (target Node 22). The shebang is added by the tsup banner, NOT in source. Imports use `.js` extensions. The version is read from `package.json` at build time.

TypeScript 7 does not auto-load `@types/*`; `tsconfig.json` lists `"types": ["node"]`.

## Constraints

- **No Next.js**: this is a CLI, intentionally not a web project
- **No GUI, no cloud sync**: terminal and local filesystem only
- **Package manager**: pnpm only
- **Node**: 22.12+ (commander 15 and tsup 9 require it; Node 20 is end-of-life)
- **No non-ASCII** in code or CLI output (clack draws its own frame; we add nothing beyond ASCII)
- **Runtime dependencies**: keep minimal (`@clack/prompts`, `commander`, `picocolors`)
- Keep `pnpm audit` clean; update dependencies rather than adding overrides where possible

## Key Implementation Rules

### Profile Name Validation
Names match `^[A-Za-z0-9_-]+$`, at most 64 characters, and must not be `help` or `version` (case-insensitive). Enforced in `validation.ts`, and again inside `paths.getProfileDir` as defense in depth. Never relax it.

### File Writes
All writes go through `atomicWrite` (unique temp file in the same directory, fsync, rename), mode `0600`, directories `0700`, because settings files contain API keys. Symlinked targets are resolved so the link is preserved. Directory/file copies for managed paths use a staging sibling and swap.

### Secrets
Never print or log an API key; display via `maskSecret`. Prefer `--api-key-env` / `--api-key-stdin` / prompt over `--api-key`. The connection test sends the key only to the profile's own base URL, never follows redirects, and redacts the key from any error text.

### Error Messages
When `~/.claude/settings.json` is missing, show this exact message:
```
No ~/.claude/settings.json found. Run Claude Code once to generate it, or run the setup script provided by your provider (e.g., Z.ai).
```

### Active Profile Protection
The active profile cannot be deleted. Switch away first.

### Rename Behavior
Renaming to the same name is a successful no-op ("Profile name unchanged").

## Testing

`pnpm test` (vitest). Tests run against temp directories via `CLAUDE_CONFIG_DIR` and `CC_SWITCH_HOME` (`test/helpers.ts`); never write to the real home directory. Catalog invariants live in `test/providers.test.ts`. For a manual end-to-end check, point both variables at `mktemp -d` directories (with `{"env":{}}` in `settings.json`), run `pnpm build`, and try `node dist/index.js --create t --template ollama --model qwen3.5` followed by `--list`; run with no arguments in a real terminal for the interactive menu.

## Publishing

CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on Node 22 and 24 across Linux, macOS and Windows, plus a weekly `pnpm audit`. Publishing is automated: `pnpm release:*` creates a GitHub release and `.github/workflows/publish.yml` publishes to npm with trusted publishing (OIDC) and provenance. Before releasing:
1. `pnpm check` and `pnpm audit` pass
2. README provider table and CHANGELOG.md are current
3. Provider defaults were re-verified against provider docs if more than a few weeks old
