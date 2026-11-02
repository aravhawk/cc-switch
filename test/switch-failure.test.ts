import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSandbox, type Sandbox } from './helpers.js';

// Fail directory copies on demand to simulate EACCES / ENOSPC half-way through a switch.
const fault = vi.hoisted(() => ({ failCopy: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    cp: (async (...args: Parameters<typeof actual.cp>) => {
      if (fault.failCopy) throw Object.assign(new Error('EACCES: simulated'), { code: 'EACCES' });
      return actual.cp(...args);
    }) as typeof actual.cp,
  };
});

const { createProfile, switchProfile } = await import('../src/profiles.js');
const { readState } = await import('../src/state.js');

let sandbox: Sandbox;
beforeEach(async () => {
  sandbox = await createSandbox({ env: { MARKER: 'other-profile-settings' } });
  fault.failCopy = false;
});
afterEach(async () => {
  fault.failCopy = false;
  await sandbox.cleanup();
});

describe('a failed switch', () => {
  it('restores the outgoing profile and never overwrites its saved settings on retry', async () => {
    await mkdir(join(sandbox.claudeDir, 'skills'), { recursive: true });
    await writeFile(join(sandbox.claudeDir, 'skills', 'a.md'), 'full1-skill');
    await createProfile('full1', { template: 'zai', apiKey: 'FULL1-SECRET-0123456789', full: true, managedPaths: ['skills'] });
    await createProfile('other', { template: 'anthropic' });
    await sandbox.writeSettings({ env: { MARKER: 'other-profile-settings', OTHER_KEY: 'OTHER-KEY-VALUE' } });

    fault.failCopy = true;
    await expect(switchProfile('full1')).rejects.toThrow(/simulated/);
    fault.failCopy = false;

    // Live settings are back to the outgoing profile's, and state still agrees.
    expect((await sandbox.readSettings()).env.OTHER_KEY).toBe('OTHER-KEY-VALUE');
    expect((await readState()).activeProfile).toBe('other');

    // Retrying must not clobber "other" with full1's settings.
    await switchProfile('full1');
    const storedOther = await readFile(join(sandbox.homeDir, 'profiles', 'other', 'settings.json'), 'utf-8');
    expect(storedOther).toContain('OTHER-KEY-VALUE');
    expect(storedOther).not.toContain('FULL1-SECRET-0123456789');
    expect((await readState()).activeProfile).toBe('full1');
  });
});
