import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommandLine } from '../src/cli.js';
import { createSandbox, type Sandbox } from './helpers.js';

let sandbox: Sandbox;
let out: string[];
let err: string[];

beforeEach(async () => {
  sandbox = await createSandbox({ env: {} });
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => void out.push(args.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...args) => void err.push(args.join(' ')));
  process.exitCode = undefined;
});

afterEach(async () => {
  process.exitCode = undefined;
  await sandbox.cleanup();
});

async function run(...args: string[]) {
  process.exitCode = undefined;
  await runCommandLine(args);
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return code;
}

describe('command line', () => {
  it('returns false when there are no arguments so interactive mode can start', async () => {
    expect(await runCommandLine([])).toBe(false);
  });

  it('creates, lists, shows and switches', async () => {
    expect(await run('--create', 'work')).toBe(0);
    expect(await run('--create', 'ds', '--template', 'deepseek', '--api-key', 'sk-test-0123456789')).toBe(0);
    expect(out.join('\n')).toContain('Created profile "ds" with template "deepseek"');

    out.length = 0;
    expect(await run('--current')).toBe(0);
    expect(out).toEqual(['Current profile: "ds"']);

    out.length = 0;
    expect(await run('--list', '--json')).toBe(0);
    const listed = JSON.parse(out.join('\n'));
    expect(listed.active).toBe('ds');
    expect(listed.profiles.map((p: { name: string }) => p.name)).toEqual(['ds', 'default', 'work']);
    expect(out.join('')).not.toContain('sk-test-0123456789');

    out.length = 0;
    expect(await run('--show', 'ds', '--json')).toBe(0);
    const shown = JSON.parse(out.join('\n'));
    expect(shown.apiKey).toBe('...6789');
    expect(shown.provider).toBe('deepseek');

    out.length = 0;
    expect(await run('work')).toBe(0);
    expect(out[0]).toBe('Switched to profile "work"');
  });

  it('ignores CC_SWITCH_API_KEY when there is no template to give a key to', async () => {
    process.env.CC_SWITCH_API_KEY = 'exported-in-my-shell';
    try {
      expect(await run('--create', 'plain')).toBe(0);
      expect(await run('--create', 'z', '--template', 'zai')).toBe(0);
      expect((await sandbox.readSettings()).env.ANTHROPIC_AUTH_TOKEN).toBe('exported-in-my-shell');
    } finally {
      delete process.env.CC_SWITCH_API_KEY;
    }
  });

  it('rejects credentials and endpoints passed through --env', async () => {
    expect(await run('--create', 'x', '--template', 'custom', '--base-url', 'https://a.example.com', '--env', 'ANTHROPIC_BASE_URL=http://u:p@evil.example')).toBe(1);
    expect(err.join('\n')).toMatch(/--base-url/);
    err.length = 0;
    expect(await run('--create', 'x', '--template', 'custom', '--base-url', 'https://a.example.com', '--env', 'ANTHROPIC_AUTH_TOKEN=secret')).toBe(1);
    expect(err.join('\n')).toMatch(/--api-key-env/);
  });

  it('checks the profile name before prompting for a key', async () => {
    expect(await run('--create', 'work')).toBe(0);
    err.length = 0;
    expect(await run('--create', 'work', '--template', 'zai')).toBe(1);
    expect(err.join('\n')).toMatch(/already exists/);
  });

  it('accepts the key from a named environment variable', async () => {
    process.env.CCS_TEST_KEY = 'env-key-0123456789';
    try {
      expect(await run('--create', 'z', '--template', 'zai', '--api-key-env', 'CCS_TEST_KEY')).toBe(0);
      expect((await sandbox.readSettings()).env.ANTHROPIC_AUTH_TOKEN).toBe('env-key-0123456789');
    } finally {
      delete process.env.CCS_TEST_KEY;
    }
  });

  it('passes cloud settings through --env', async () => {
    expect(await run('--create', 'gcp', '--template', 'vertex', '--env', 'ANTHROPIC_VERTEX_PROJECT_ID=my-proj', '--env', 'CLOUD_ML_REGION=us-east5')).toBe(0);
    expect((await sandbox.readSettings()).env).toMatchObject({
      CLAUDE_CODE_USE_VERTEX: '1',
      ANTHROPIC_VERTEX_PROJECT_ID: 'my-proj',
      CLOUD_ML_REGION: 'us-east5',
    });
  });

  it('rejects invalid combinations with exit code 1 and a clear message', async () => {
    const cases: Array<[string[], RegExp]> = [
      [['--template', 'zai', '--list'], /only be used with --create/],
      [['--api-key', 'x', '--list'], /only be used with --create or --set-key/],
      [['--create', 'x', '--api-key', 'k'], /only be used with --template/],
      [['--list', '--current'], /only one action/],
      [['work', '--list'], /Do not combine/],
      [['--create', 'x', '--template', 'nope'], /Unknown provider/],
      [['--create', 'x', '--include', 'skills'], /--full/],
      [['--create', 'x', '--full', '--include', 'bogus'], /Invalid managed path/],
      [['--create', 'x', '--template', 'custom', '--base-url', 'https://a.example.com', '--env', 'bad'], /NAME=VALUE/],
      [['--json', '--delete', 'x'], /--json can only/],
    ];
    for (const [args, message] of cases) {
      err.length = 0;
      expect(await run(...args), args.join(' ')).toBe(1);
      expect(err.join('\n'), args.join(' ')).toMatch(message);
    }
  });

  it('lets commander report malformed options (exit code 1)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await run('--rename')).toBe(1);
    expect(stderr.mock.calls.join('')).toMatch(/argument missing/);
  });

  it('keeps reserved words and the version/help shortcuts', async () => {
    expect(await run('--create', 'help')).toBe(1);
    expect(await run('version')).toBe(0);
    expect(out[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('lists providers as JSON', async () => {
    expect(await run('--providers', '--json')).toBe(0);
    const providers = JSON.parse(out.join('\n'));
    expect(providers.length).toBeGreaterThan(30);
    expect(providers.find((p: { id: string }) => p.id === 'zai').endpoints.map((e: { id: string }) => e.id)).toEqual(['global', 'china']);
  });
});
