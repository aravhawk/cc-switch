import { lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertCanCreate,
  clearProfileProvider,
  createProfile,
  deleteProfile,
  findShellEnvConflicts,
  getActiveProfileStatus,
  getProfileDetails,
  listProfiles,
  planManagedTransition,
  refreshProfileFromTemplate,
  renameProfile,
  setProfileApiKey,
  setProfileModels,
  switchProfile,
} from '../src/profiles.js';
import { readState } from '../src/state.js';
import { createSandbox, type Sandbox } from './helpers.js';

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await createSandbox({
    env: { DISABLE_TELEMETRY: '1' },
    permissions: { allow: ['Bash(ls)'] },
  });
});

afterEach(async () => {
  await sandbox.cleanup();
});

const exists = (path: string) => stat(path).then(() => true, () => false);

describe('create', () => {
  it('copies current settings and makes the new profile active', async () => {
    await createProfile('work');
    expect((await getActiveProfileStatus()).name).toBe('work');
    const stored = JSON.parse(await readFile(join(sandbox.homeDir, 'profiles', 'work', 'settings.json'), 'utf-8'));
    expect(stored.permissions.allow).toEqual(['Bash(ls)']);
  });

  it('saves the profile it is leaving, even without a template', async () => {
    await createProfile('first');
    await sandbox.writeSettings({ env: { CHANGED_IN_FIRST: '1' } });
    await createProfile('second');
    const first = JSON.parse(await readFile(join(sandbox.homeDir, 'profiles', 'first', 'settings.json'), 'utf-8'));
    expect(first.env.CHANGED_IN_FIRST).toBe('1');
  });

  it('preserves the original settings as the default profile on first use', async () => {
    await createProfile('kimi', { template: 'kimi', apiKey: 'sk-test-0123456789' });
    const saved = JSON.parse(await readFile(join(sandbox.homeDir, 'profiles', 'default', 'settings.json'), 'utf-8'));
    expect(saved.env).toEqual({ DISABLE_TELEMETRY: '1' });
    const live = await sandbox.readSettings();
    expect(live.env.ANTHROPIC_BASE_URL).toContain('kimi');
  });

  it('applies a template, keeping unrelated settings and recording the provider', async () => {
    const result = await createProfile('glm', { template: 'zai', apiKey: 'zai-key-0123456789' });
    expect(result.provider?.id).toBe('zai');
    expect(result.summary.providerId).toBe('zai');
    const live = await sandbox.readSettings();
    expect(live.env).toMatchObject({
      DISABLE_TELEMETRY: '1',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'zai-key-0123456789',
    });
    expect(live.permissions.allow).toEqual(['Bash(ls)']);
  });

  it('does not carry one provider\'s settings into the next template', async () => {
    await createProfile('a', { template: 'deepseek', apiKey: 'k1-0123456789' });
    await createProfile('b', { template: 'zai', apiKey: 'k2-0123456789' });
    const env = (await sandbox.readSettings()).env;
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });

  it('the anthropic template removes custom provider settings', async () => {
    await createProfile('a', { template: 'deepseek', apiKey: 'k1-0123456789' });
    await createProfile('plain', { template: 'anthropic' });
    expect((await sandbox.readSettings()).env).toEqual({ DISABLE_TELEMETRY: '1' });
  });

  it('requires an API key for hosted providers but not for local ones', async () => {
    await expect(createProfile('x', { template: 'zai' })).rejects.toThrow(/API key is required/);
    await createProfile('local', { template: 'ollama', models: { model: 'qwen3.5' } });
    const env = (await sandbox.readSettings()).env;
    expect(env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_API_KEY: '', ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.5' });
  });

  it('rejects provider options without a template', async () => {
    await expect(createProfile('x', { apiKey: 'abc' })).rejects.toThrow(/template/);
    await expect(createProfile('x', { baseUrl: 'https://a.example.com' })).rejects.toThrow(/template/);
  });

  it('refuses duplicate names and invalid names, and leaves nothing behind', async () => {
    await createProfile('work');
    await expect(createProfile('work')).rejects.toThrow(/already exists/);
    await expect(createProfile('../evil')).rejects.toThrow();
    expect(await exists(join(sandbox.homeDir, 'profiles', '..', 'evil'))).toBe(false);
  });

  it('fails clearly when Claude Code has not created settings.json yet', async () => {
    const { rm } = await import('node:fs/promises');
    await rm(sandbox.settingsPath);
    await expect(createProfile('x')).rejects.toThrow('No ~/.claude/settings.json found. Run Claude Code once to generate it, or run the setup script provided by your provider (e.g., Z.ai).');
  });

  it('refuses to template over an unparseable settings.json without changing anything', async () => {
    await writeFile(sandbox.settingsPath, '{ not json');
    await expect(createProfile('x', { template: 'zai', apiKey: 'k-0123456789' })).rejects.toThrow(/not valid JSON/);
    expect(await readFile(sandbox.settingsPath, 'utf-8')).toBe('{ not json');
    expect(await exists(join(sandbox.homeDir, 'profiles', 'x'))).toBe(false);
  });

  it('rolls back a failed create', async () => {
    // A file where the profile's managed directory should be forces the copy to fail mid-way.
    await mkdir(join(sandbox.claudeDir, 'skills'), { recursive: true });
    await writeFile(join(sandbox.claudeDir, 'skills', 'a.md'), 'a');
    await createProfile('base');
    const before = await readFile(sandbox.settingsPath, 'utf-8');
    await expect(
      createProfile('broken', { template: 'zai', apiKey: 'k-0123456789', full: true, managedPaths: ['not-a-real-path'] })
    ).rejects.toThrow(/Invalid managed path/);
    expect(await exists(join(sandbox.homeDir, 'profiles', 'broken'))).toBe(false);
    expect(await readFile(sandbox.settingsPath, 'utf-8')).toBe(before);
    expect((await readState()).activeProfile).toBe('base');
  });
});

describe('file safety', () => {
  it.skipIf(process.platform === 'win32')('stores settings and state privately (0600) in a private directory', async () => {
    await createProfile('kimi', { template: 'kimi', apiKey: 'sk-test-0123456789' });
    const mode = async (path: string) => (await stat(path)).mode & 0o777;
    expect(await mode(sandbox.settingsPath)).toBe(0o600);
    expect(await mode(join(sandbox.homeDir, 'state.json'))).toBe(0o600);
    expect(await mode(join(sandbox.homeDir, 'profiles', 'kimi', 'settings.json'))).toBe(0o600);
    expect(await mode(sandbox.homeDir)).toBe(0o700);
  });

  it.skipIf(process.platform === 'win32')('writes through a symlinked settings.json instead of replacing it', async () => {
    const { rename } = await import('node:fs/promises');
    const real = join(sandbox.claudeDir, 'dotfiles-settings.json');
    await rename(sandbox.settingsPath, real);
    await symlink(real, sandbox.settingsPath);
    await createProfile('kimi', { template: 'kimi', apiKey: 'sk-test-0123456789' });
    expect((await lstat(sandbox.settingsPath)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, 'utf-8')).env.ANTHROPIC_BASE_URL).toContain('kimi');
  });

  it('leaves no temp files behind', async () => {
    await createProfile('a');
    await createProfile('b', { template: 'zai', apiKey: 'k-0123456789' });
    await switchProfile('a');
    const all = [
      ...(await readdir(sandbox.claudeDir)),
      ...(await readdir(sandbox.homeDir)),
      ...(await readdir(join(sandbox.homeDir, 'profiles', 'a'))),
    ];
    expect(all.filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects a state file pointing outside the profiles directory', async () => {
    await createProfile('a');
    await writeFile(join(sandbox.homeDir, 'state.json'), JSON.stringify({ activeProfile: '../../etc' }));
    await expect(listProfiles()).rejects.toThrow(/invalid/i);
  });
});

describe('switch', () => {
  it('mirrors the outgoing profile and loads the target', async () => {
    await createProfile('a');
    await createProfile('b', { template: 'zai', apiKey: 'k-0123456789' });
    await sandbox.writeSettings({ ...(await sandbox.readSettings()), extra: 'edited-in-b' });

    const result = await switchProfile('a');
    expect(result.from).toBe('b');
    expect((await sandbox.readSettings()).env.ANTHROPIC_BASE_URL).toBeUndefined();

    await switchProfile('b');
    const live = await sandbox.readSettings();
    expect(live.extra).toBe('edited-in-b');
    expect(live.env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
  });

  it('errors for unknown or already-active profiles without changing anything', async () => {
    await createProfile('a');
    const before = await readFile(sandbox.settingsPath, 'utf-8');
    await expect(switchProfile('a')).rejects.toThrow(/already active/);
    await expect(switchProfile('ghost')).rejects.toThrow(/does not exist/);
    expect(await readFile(sandbox.settingsPath, 'utf-8')).toBe(before);
  });

  it('does not change anything when the target is damaged', async () => {
    await createProfile('a');
    await createProfile('b');
    const { rm } = await import('node:fs/promises');
    await rm(join(sandbox.homeDir, 'profiles', 'a', 'settings.json'));
    const before = await readFile(sandbox.settingsPath, 'utf-8');
    await expect(switchProfile('a')).rejects.toThrow(/no settings.json/);
    expect(await readFile(sandbox.settingsPath, 'utf-8')).toBe(before);
    expect((await readState()).activeProfile).toBe('b');
  });

  it('warns about provider variables exported in the shell', () => {
    expect(findShellEnvConflicts({ ANTHROPIC_BASE_URL: 'https://x' })).toEqual(['ANTHROPIC_BASE_URL']);
    expect(findShellEnvConflicts({})).toEqual([]);
    // Inside Claude Code the environment is built from settings.json itself, so it is not a conflict.
    expect(findShellEnvConflicts({ CLAUDECODE: '1', ANTHROPIC_BASE_URL: 'https://x' })).toEqual([]);
  });
});

describe('full profiles', () => {
  async function seed() {
    await mkdir(join(sandbox.claudeDir, 'skills', 'mine'), { recursive: true });
    await writeFile(join(sandbox.claudeDir, 'skills', 'mine', 'SKILL.md'), 'mine');
    await writeFile(join(sandbox.claudeDir, 'CLAUDE.md'), 'work instructions');
  }

  it('swaps managed paths with the profile', async () => {
    await seed();
    await createProfile('work', { full: true, managedPaths: ['CLAUDE.md', 'skills'] });

    await createProfile('kimi', { template: 'kimi', apiKey: 'sk-test-0123456789', full: true, managedPaths: ['CLAUDE.md', 'skills'] });
    await writeFile(join(sandbox.claudeDir, 'CLAUDE.md'), 'kimi instructions');

    await switchProfile('work');
    expect(await readFile(join(sandbox.claudeDir, 'CLAUDE.md'), 'utf-8')).toBe('work instructions');

    await switchProfile('kimi');
    expect(await readFile(join(sandbox.claudeDir, 'CLAUDE.md'), 'utf-8')).toBe('kimi instructions');
  });

  it('removes a managed path the target profile does not own, reporting it', async () => {
    await seed();
    await createProfile('full', { full: true, managedPaths: ['CLAUDE.md', 'skills'] });
    await createProfile('plain');
    const result = await switchProfile('full');
    expect(result.cleared).toEqual([]);
    const back = await switchProfile('plain');
    expect(back.cleared.sort()).toEqual(['CLAUDE.md', 'skills']);
    expect(await exists(join(sandbox.claudeDir, 'CLAUDE.md'))).toBe(false);
    // ...but it is still saved in the full profile
    expect(await exists(join(sandbox.homeDir, 'profiles', 'full', 'CLAUDE.md'))).toBe(true);
  });

  it('does not leak the outgoing profile\'s file into a target that has none stored', async () => {
    // Neither profile has a CLAUDE.md when created.
    await createProfile('a', { full: true, managedPaths: ['CLAUDE.md'] });
    await createProfile('b', { full: true, managedPaths: ['CLAUDE.md'] });
    await writeFile(join(sandbox.claudeDir, 'CLAUDE.md'), 'b only');
    await switchProfile('a');
    expect(await exists(join(sandbox.claudeDir, 'CLAUDE.md'))).toBe(false);
    await switchProfile('b');
    expect(await readFile(join(sandbox.claudeDir, 'CLAUDE.md'), 'utf-8')).toBe('b only');
  });

  it('leaves files the outgoing profile did not manage alone', async () => {
    await writeFile(join(sandbox.claudeDir, 'CLAUDE.md'), 'personal');
    await createProfile('settings-only');
    await createProfile('other', { full: true, managedPaths: ['skills'] });
    await switchProfile('settings-only');
    expect(await readFile(join(sandbox.claudeDir, 'CLAUDE.md'), 'utf-8')).toBe('personal');
  });

  it('plans transitions between profiles with different managed sets', () => {
    const full = (paths: string[]) => ({ type: 'full' as const, version: 1, managedPaths: paths });
    expect(planManagedTransition(full(['skills', 'agents']), full(['skills']))).toMatchObject({ load: ['skills'], clear: ['agents'] });
    expect(planManagedTransition(null, full(['skills']))).toMatchObject({ load: ['skills'], clear: [] });
    expect(planManagedTransition(full(['skills']), null)).toMatchObject({ load: [], clear: ['skills'] });
  });
});

describe('delete and rename', () => {
  it('refuses to delete the active profile and deletes others', async () => {
    await createProfile('a');
    await createProfile('b');
    await expect(deleteProfile('b')).rejects.toThrow(/active profile/);
    await deleteProfile('a');
    expect(await exists(join(sandbox.homeDir, 'profiles', 'a'))).toBe(false);
    await expect(deleteProfile('a')).rejects.toThrow(/does not exist/);
  });

  it('renames, follows the active marker, and treats same-name as a no-op', async () => {
    await createProfile('a');
    await renameProfile('a', 'z');
    expect((await getActiveProfileStatus()).name).toBe('z');
    await renameProfile('z', 'z');
    await createProfile('other');
    await expect(renameProfile('z', 'other')).rejects.toThrow(/already exists/);
    await expect(renameProfile('ghost', 'x')).rejects.toThrow(/does not exist/);
    await expect(renameProfile('z', 'bad/name')).rejects.toThrow(/Invalid new profile name/);
  });
});

describe('list and details', () => {
  it('shows live settings for the active profile and detects providers', async () => {
    await createProfile('base');
    await createProfile('ds', { template: 'deepseek', apiKey: 'sk-ds-0123456789' });
    const profiles = await listProfiles();
    expect(profiles.map(p => p.name)).toEqual(['ds', 'base', 'default']);
    expect(profiles[0]).toMatchObject({ isActive: true, summary: { providerId: 'deepseek' } });
    expect(profiles[1]!.summary.providerId).toBe('anthropic');
    expect(JSON.stringify(profiles)).not.toContain('sk-ds-0123456789');
  });

  it('ignores directories that are not valid profile names', async () => {
    await createProfile('a');
    await mkdir(join(sandbox.homeDir, 'profiles', 'not a profile'), { recursive: true });
    await mkdir(join(sandbox.homeDir, 'profiles', '.hidden'), { recursive: true });
    expect((await listProfiles()).map(p => p.name)).toEqual(['a', 'default']);
  });

  it('survives a profile with unreadable settings', async () => {
    await createProfile('a');
    await createProfile('b');
    await writeFile(join(sandbox.homeDir, 'profiles', 'a', 'settings.json'), '{broken');
    const profiles = await listProfiles();
    expect(profiles.find(p => p.name === 'a')!.summary.unreadable).toBe(true);
    expect((await getProfileDetails('b')).isActive).toBe(true);
  });
});

describe('edit', () => {
  it('rotates the API key of a stored profile without touching live settings', async () => {
    await createProfile('ds', { template: 'deepseek', apiKey: 'old-key-0123456789' });
    await createProfile('other', { template: 'anthropic' });
    await setProfileApiKey('ds', 'new-key-0123456789');
    const stored = JSON.parse(await readFile(join(sandbox.homeDir, 'profiles', 'ds', 'settings.json'), 'utf-8'));
    expect(stored.env.ANTHROPIC_AUTH_TOKEN).toBe('new-key-0123456789');
    expect((await sandbox.readSettings()).env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('updates live and stored settings for the active profile', async () => {
    await createProfile('ds', { template: 'deepseek', apiKey: 'old-key-0123456789' });
    await setProfileApiKey('ds', 'new-key-0123456789');
    expect((await sandbox.readSettings()).env.ANTHROPIC_AUTH_TOKEN).toBe('new-key-0123456789');
    await switchProfileRoundTrip();
    expect((await sandbox.readSettings()).env.ANTHROPIC_AUTH_TOKEN).toBe('new-key-0123456789');
  });

  async function switchProfileRoundTrip() {
    await createProfile('tmp');
    await switchProfile('ds');
  }

  it('refuses to set a key on a profile without a custom endpoint', async () => {
    await createProfile('plain');
    await expect(setProfileApiKey('plain', 'abc')).rejects.toThrow(/no key to update/);
    await expect(setProfileApiKey('plain', '   ')).rejects.toThrow(/empty/);
  });

  it('changes models and re-applies provider defaults while keeping the key', async () => {
    await createProfile('ds', { template: 'deepseek', apiKey: 'key-0123456789ab' });
    await setProfileModels('ds', { model: 'deepseek-v4-pro' });
    expect((await sandbox.readSettings()).env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro');

    const refreshed = await refreshProfileFromTemplate('ds');
    expect(refreshed.provider.id).toBe('deepseek');
    const env = (await sandbox.readSettings()).env;
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-flash[1m]');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('key-0123456789ab');
  });

  it('keeps the chosen endpoint when refreshing', async () => {
    await createProfile('z', { template: 'zai', endpoint: 'china', apiKey: 'key-0123456789ab' });
    await refreshProfileFromTemplate('z');
    expect((await sandbox.readSettings()).env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
  });

  it('refresh keeps cloud fields and the Bedrock Mantle variant, and refuses providers without defaults', async () => {
    await createProfile('gcp', { template: 'vertex', env: { ANTHROPIC_VERTEX_PROJECT_ID: 'proj-1', CLOUD_ML_REGION: 'us-east5' } });
    await refreshProfileFromTemplate('gcp');
    expect((await sandbox.readSettings()).env).toMatchObject({
      CLAUDE_CODE_USE_VERTEX: '1',
      ANTHROPIC_VERTEX_PROJECT_ID: 'proj-1',
      CLOUD_ML_REGION: 'us-east5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
    });

    await createProfile('aws', { template: 'bedrock', endpoint: 'mantle', env: { AWS_REGION: 'us-west-2' } });
    await refreshProfileFromTemplate('aws');
    expect((await sandbox.readSettings()).env).toMatchObject({
      CLAUDE_CODE_USE_MANTLE: '1',
      AWS_REGION: 'us-west-2',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic.claude-sonnet-5-5',
    });

    await createProfile('local', { template: 'ollama', models: { model: 'qwen3.5' } });
    await expect(refreshProfileFromTemplate('local')).rejects.toThrow(/no recommended model defaults/);
  });

  it('can remove a custom provider', async () => {
    await createProfile('ds', { template: 'deepseek', apiKey: 'key-0123456789ab' });
    await clearProfileProvider('ds');
    expect((await sandbox.readSettings()).env).toEqual({ DISABLE_TELEMETRY: '1' });
  });
});

describe('regressions from review', () => {
  it('refuses to create or rename onto the active profile name, even without a stored copy', async () => {
    // Fresh install: the active profile is the implicit "default" and has no directory yet.
    await sandbox.writeSettings({ env: { ORIGINAL: 'keep-me' } });
    await expect(createProfile('default', { template: 'kimi', apiKey: 'k-0123456789ab' })).rejects.toThrow(/currently active/);
    expect(JSON.stringify(await sandbox.readSettings())).toContain('keep-me');

    await createProfile('x');
    await switchProfile('default').catch(() => undefined);
    await expect(renameProfile('x', 'default')).rejects.toThrow();
  });

  it('create from a full profile removes the paths the new profile does not manage, and keeps them in the old one', async () => {
    await mkdir(join(sandbox.claudeDir, 'skills'), { recursive: true });
    await writeFile(join(sandbox.claudeDir, 'skills', 'a.md'), 'A1');
    await createProfile('full', { full: true, managedPaths: ['skills'] });

    const result = await createProfile('plain');
    expect(result.cleared).toEqual(['skills']);
    expect(await exists(join(sandbox.claudeDir, 'skills'))).toBe(false);

    await switchProfile('full');
    expect(await readFile(join(sandbox.claudeDir, 'skills', 'a.md'), 'utf-8')).toBe('A1');
  });

  it('create keeps shared managed paths and copies them into the new profile', async () => {
    await mkdir(join(sandbox.claudeDir, 'skills'), { recursive: true });
    await writeFile(join(sandbox.claudeDir, 'skills', 'a.md'), 'shared');
    await createProfile('one', { full: true, managedPaths: ['skills'] });
    const result = await createProfile('two', { full: true, managedPaths: ['skills'] });
    expect(result.cleared).toEqual([]);
    expect(await readFile(join(sandbox.homeDir, 'profiles', 'two', 'skills', 'a.md'), 'utf-8')).toBe('shared');
  });

  it('assertCanCreate fails before anything is written', async () => {
    await createProfile('a');
    await expect(assertCanCreate('a')).rejects.toThrow(/already exists/);
    await expect(assertCanCreate('bad name')).rejects.toThrow();
    await expect(assertCanCreate('fresh')).resolves.toBeUndefined();
  });

  it('show, test details and key rotation work for the active profile before its first mirror', async () => {
    await sandbox.writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'old-key-0123456789' } });
    const details = await getProfileDetails('default');
    expect(details.isActive).toBe(true);
    expect(details.summary.providerId).toBe('deepseek');
    await setProfileApiKey('default', 'new-key-0123456789');
    expect((await sandbox.readSettings()).env.ANTHROPIC_AUTH_TOKEN).toBe('new-key-0123456789');
    await expect(getProfileDetails('ghost')).rejects.toThrow(/does not exist/);
  });

  it('a single model for everything also updates subagents, and tier edits move ANTHROPIC_MODEL', async () => {
    await createProfile('ds', { template: 'deepseek', apiKey: 'key-0123456789ab' });
    await setProfileModels('ds', { model: 'deepseek-v4-pro' });
    let env = (await sandbox.readSettings()).env;
    expect(env).toMatchObject({
      ANTHROPIC_MODEL: 'deepseek-v4-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-pro',
    });
    await setProfileModels('ds', { sonnet: 'my-sonnet' });
    env = (await sandbox.readSettings()).env;
    expect(env.ANTHROPIC_MODEL).toBe('my-sonnet');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro');
  });

  it('refresh keeps a Foundry API key', async () => {
    await createProfile('az', { template: 'foundry', env: { ANTHROPIC_FOUNDRY_RESOURCE: 'res' } });
    const live = await sandbox.readSettings();
    await sandbox.writeSettings({ ...live, env: { ...live.env, ANTHROPIC_FOUNDRY_API_KEY: 'foundry-key-0123456789' } });
    await refreshProfileFromTemplate('az');
    expect((await sandbox.readSettings()).env).toMatchObject({
      ANTHROPIC_FOUNDRY_API_KEY: 'foundry-key-0123456789',
      ANTHROPIC_FOUNDRY_RESOURCE: 'res',
    });
  });

  it('keeps the telemetry opt-out across providers', async () => {
    await sandbox.writeSettings({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    await createProfile('a', { template: 'deepseek', apiKey: 'k-0123456789abcd' });
    await createProfile('b', { template: 'ollama', models: { model: 'm' } });
    await createProfile('c', { template: 'anthropic' });
    expect((await sandbox.readSettings()).env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });
});
