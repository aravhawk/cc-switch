import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { STATE_FILE, CC_SWITCH_DIR } from './paths.js';
import type { State } from './types.js';

const DEFAULT_STATE: State = {
  activeProfile: 'default',
  lastSyncedAt: new Date().toISOString(),
};

export async function readState(): Promise<State> {
  try {
    const data = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(data) as State;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return DEFAULT_STATE;
    }
    throw error;
  }
}

export async function writeState(state: State): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });

  // Atomic write: write to temp file then rename
  const tempFile = `${STATE_FILE}.tmp`;
  await writeFile(tempFile, JSON.stringify(state, null, 2), 'utf-8');
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

export async function updateState(updates: Partial<State>): Promise<State> {
  const currentState = await readState();
  const newState: State = {
    ...currentState,
    ...updates,
    lastSyncedAt: new Date().toISOString(),
  };
  await writeState(newState);
  return newState;
}
