/**
 * API key input for non-interactive use. Passing a secret as a command-line argument leaks it into
 * shell history and the process list, so alternatives are offered:
 *   --api-key-stdin       read the key from standard input (e.g. `pass show kimi | cc-switch ...`)
 *   --api-key-env <NAME>  read the key from the named environment variable
 *   CC_SWITCH_API_KEY     fallback environment variable
 *   --api-key <key>       still accepted for scripts and backwards compatibility
 */
export interface ApiKeyFlags {
  apiKey?: string;
  apiKeyEnv?: string;
  apiKeyStdin?: boolean;
}

export const API_KEY_ENV_FALLBACK = 'CC_SWITCH_API_KEY';

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('--api-key-stdin expects the key to be piped in, for example: pass show my-key | cc-switch ...');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

export function hasExplicitApiKeySource(flags: ApiKeyFlags): boolean {
  return Boolean(flags.apiKey || flags.apiKeyEnv || flags.apiKeyStdin);
}

export async function resolveApiKey(flags: ApiKeyFlags, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const sources = [flags.apiKey ? '--api-key' : '', flags.apiKeyEnv ? '--api-key-env' : '', flags.apiKeyStdin ? '--api-key-stdin' : '']
    .filter(Boolean);
  if (sources.length > 1) {
    throw new Error(`Use only one of --api-key, --api-key-env and --api-key-stdin (got ${sources.join(', ')})`);
  }

  if (flags.apiKeyStdin) {
    const key = await readAllStdin();
    if (!key) throw new Error('No API key was received on standard input');
    return key;
  }

  if (flags.apiKeyEnv) {
    const key = env[flags.apiKeyEnv]?.trim();
    if (!key) throw new Error(`Environment variable ${flags.apiKeyEnv} is not set or is empty`);
    return key;
  }

  if (flags.apiKey) {
    const key = flags.apiKey.trim();
    if (!key) throw new Error('API key cannot be empty');
    return key;
  }

  return env[API_KEY_ENV_FALLBACK]?.trim() || undefined;
}
