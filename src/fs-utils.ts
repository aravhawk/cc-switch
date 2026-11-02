import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, realpath, rename, rm, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Resolve symlinks so that a symlinked config file (dotfile managers such as
 * stow or chezmoi) is updated in place instead of being replaced by a regular file.
 */
async function resolveWriteTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNotFound(error)) return path;
    throw error;
  }
}

/**
 * Write a file atomically: unique temp file in the same directory, fsync, rename.
 * Files are created private (0600) because settings files can contain API keys.
 */
export async function atomicWrite(
  path: string,
  data: string,
  mode: number = PRIVATE_FILE_MODE
): Promise<void> {
  const target = await resolveWriteTarget(path);
  await mkdir(dirname(target), { recursive: true, mode: PRIVATE_DIR_MODE });

  const tempFile = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const handle = await open(tempFile, 'w', mode);
    try {
      await handle.writeFile(data, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempFile, target);
    // Some platforms ignore the mode passed to open() when umask is restrictive
    // or when the file is reused; enforce it explicitly.
    await chmod(target, mode).catch(() => undefined);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
}
