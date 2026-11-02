import { atomicWrite, isNotFound } from './fs-utils.js';
import { readFile } from 'node:fs/promises';
import { getStateFilePath } from './paths.js';
import { validateProfileName } from './validation.js';
import type { State } from './types.js';

export const DEFAULT_PROFILE_NAME = 'default';

function defaultState(): State {
  return {
    activeProfile: DEFAULT_PROFILE_NAME,
    lastSyncedAt: new Date().toISOString(),
  };
}

export async function readState(): Promise<State> {
  const statePath = getStateFilePath();
  let raw: string;
  try {
    raw = await readFile(statePath, 'utf-8');
  } catch (error) {
    if (isNotFound(error)) return defaultState();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`State file is corrupt: ${statePath}. Delete it to reset the active profile marker.`);
  }

  const candidate = parsed as Partial<State> | null;
  if (
    !candidate ||
    typeof candidate.activeProfile !== 'string' ||
    !validateProfileName(candidate.activeProfile).valid
  ) {
    throw new Error(`State file is invalid: ${statePath}. Delete it to reset the active profile marker.`);
  }

  return {
    activeProfile: candidate.activeProfile,
    lastSyncedAt: typeof candidate.lastSyncedAt === 'string' ? candidate.lastSyncedAt : new Date().toISOString(),
  };
}

export async function writeState(state: State): Promise<void> {
  await atomicWrite(getStateFilePath(), `${JSON.stringify(state, null, 2)}\n`);
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
