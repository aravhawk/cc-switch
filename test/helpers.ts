import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Sandbox {
  claudeDir: string;
  homeDir: string;
  settingsPath: string;
  cleanup: () => Promise<void>;
  writeSettings: (settings: unknown) => Promise<void>;
  readSettings: () => Promise<Record<string, any>>;
}

/** Point cc-switch at throwaway directories so tests never touch the real ~/.claude. */
export async function createSandbox(initialSettings: unknown = { env: {} }): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'cc-switch-test-'));
  const claudeDir = join(root, 'claude');
  const homeDir = join(root, 'cc-switch');
  await mkdir(claudeDir, { recursive: true });

  const previous = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CC_SWITCH_HOME: process.env.CC_SWITCH_HOME,
  };
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CC_SWITCH_HOME = homeDir;

  const settingsPath = join(claudeDir, 'settings.json');
  const writeSettings = (settings: unknown) => writeFile(settingsPath, JSON.stringify(settings, null, 2));
  await writeSettings(initialSettings);

  return {
    claudeDir,
    homeDir,
    settingsPath,
    writeSettings,
    readSettings: async () => JSON.parse(await readFile(settingsPath, 'utf-8')),
    cleanup: async () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
