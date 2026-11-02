import { describe, expect, it } from 'vitest';
import { resolveApiKey } from '../src/api-key.js';

describe('resolveApiKey', () => {
  it('prefers explicit sources and trims', async () => {
    expect(await resolveApiKey({ apiKey: '  abc  ' }, {})).toBe('abc');
    expect(await resolveApiKey({ apiKeyEnv: 'MY_KEY' }, { MY_KEY: ' from-env ' })).toBe('from-env');
  });

  it('falls back to CC_SWITCH_API_KEY', async () => {
    expect(await resolveApiKey({}, { CC_SWITCH_API_KEY: 'fallback' })).toBe('fallback');
    expect(await resolveApiKey({}, {})).toBeUndefined();
  });

  it('rejects ambiguous or empty sources', async () => {
    await expect(resolveApiKey({ apiKey: 'a', apiKeyEnv: 'X' }, { X: 'b' })).rejects.toThrow(/only one/);
    await expect(resolveApiKey({ apiKeyEnv: 'MISSING' }, {})).rejects.toThrow(/MISSING/);
    await expect(resolveApiKey({ apiKey: '   ' }, {})).rejects.toThrow(/empty/);
  });
});
