import { describe, expect, it } from 'vitest';
import {
  applyProvider,
  clearProvider,
  maskSecret,
  parseSettings,
  replaceCredential,
  replaceModels,
  summarizeSettings,
} from '../src/settings.js';

const base = { models: {}, env: {} };

describe('applyProvider', () => {
  it('clears provider keys left by a previous provider but keeps unrelated env', () => {
    const before = {
      env: {
        DISABLE_TELEMETRY: '1',
        ANTHROPIC_BASE_URL: 'https://old.example.com',
        ANTHROPIC_API_KEY: 'old-key',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'old-model',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '123456',
        API_TIMEOUT_MS: '1',
      },
    };
    const after = applyProvider(before, {
      ...base,
      baseUrl: 'https://new.example.com',
      auth: 'token',
      apiKey: 'new-key',
      models: { sonnet: 'new-model' },
    });
    // API_TIMEOUT_MS is kept: the old endpoint is not a known provider, so it cannot be the template's value.
    expect(after.env).toEqual({
      DISABLE_TELEMETRY: '1',
      API_TIMEOUT_MS: '1',
      ANTHROPIC_BASE_URL: 'https://new.example.com',
      ANTHROPIC_AUTH_TOKEN: 'new-key',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'new-model',
    });
  });

  it('writes the key to the variable the provider expects', () => {
    const token = applyProvider({}, { ...base, baseUrl: 'https://a', auth: 'token', apiKey: 'k' });
    const apiKey = applyProvider({}, { ...base, baseUrl: 'https://a', auth: 'api-key', apiKey: 'k' });
    const both = applyProvider({}, { ...base, baseUrl: 'https://a', auth: 'both', apiKey: 'k' });
    expect(token.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'k' });
    expect(token.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(apiKey.env).toMatchObject({ ANTHROPIC_API_KEY: 'k' });
    expect(apiKey.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(both.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_API_KEY: 'k' });
  });

  it('writes a placeholder token for local servers', () => {
    const result = applyProvider({}, { ...base, baseUrl: 'http://localhost:11434', auth: 'none', placeholderToken: 'ollama' });
    expect(result.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'ollama' });
  });

  it('lets provider env override, including explicit empty strings', () => {
    const result = applyProvider({}, {
      ...base,
      baseUrl: 'https://a',
      auth: 'token',
      apiKey: 'k',
      env: { ANTHROPIC_API_KEY: '' },
    });
    expect(result.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_API_KEY: '' });
  });

  it('removes a pinned Claude model from the top-level model setting but keeps aliases', () => {
    const provider = { ...base, baseUrl: 'https://a', auth: 'token' as const, apiKey: 'k' };
    expect(applyProvider({ model: 'claude-opus-4-1' }, provider)).not.toHaveProperty('model');
    expect(applyProvider({ model: 'opus[1m]' }, provider)).toHaveProperty('model', 'opus[1m]');
    expect(applyProvider({ model: 'sonnet' }, provider)).toHaveProperty('model', 'sonnet');
  });

  it('does not touch unrelated top-level settings', () => {
    const settings = { permissions: { allow: ['Bash(ls)'] }, hooks: { x: 1 } };
    const result = applyProvider(settings, { ...base, baseUrl: 'https://a', auth: 'token', apiKey: 'k' });
    expect(result.permissions).toEqual(settings.permissions);
    expect(result.hooks).toEqual(settings.hooks);
  });

  it('does not mutate its input', () => {
    const settings = { env: { ANTHROPIC_API_KEY: 'x', KEEP: '1' } };
    const copy = structuredClone(settings);
    applyProvider(settings, { ...base, baseUrl: 'https://a', auth: 'token', apiKey: 'k' });
    expect(settings).toEqual(copy);
  });
});

describe('env ownership', () => {
  it('never removes the telemetry opt-out, even when the previous provider set it', () => {
    const zai = applyProvider({}, {
      ...base,
      baseUrl: 'https://api.z.ai/api/anthropic',
      auth: 'token',
      apiKey: 'k',
      env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', API_TIMEOUT_MS: '3000000' },
    });
    const moved = applyProvider(zai, { ...base, baseUrl: 'https://api.deepseek.com/anthropic', auth: 'token', apiKey: 'k2' });
    expect((moved.env as Record<string, string>).CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    // ...while the timeout the Z.ai template set does not follow you to DeepSeek.
    expect((moved.env as Record<string, string>).API_TIMEOUT_MS).toBeUndefined();
    expect(clearProvider(zai).env).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  });

  it('keeps tuning values the user set themselves', () => {
    const settings = { env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ENABLE_TOOL_SEARCH: 'true', AWS_REGION: 'eu-west-1' } };
    const moved = applyProvider(settings, { ...base, baseUrl: 'https://api.z.ai/api/anthropic', auth: 'token', apiKey: 'k' });
    expect(moved.env).toMatchObject({ ENABLE_TOOL_SEARCH: 'true', AWS_REGION: 'eu-west-1' });
  });

  it('removes cloud fields when leaving a cloud provider', () => {
    const settings = { env: { CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_PROJECT_ID: 'p', CLOUD_ML_REGION: 'global', KEEP: '1' } };
    expect(clearProvider(settings).env).toEqual({ KEEP: '1' });
  });
});

describe('clearProvider', () => {
  it('returns settings to Claude Code defaults', () => {
    const result = clearProvider({
      env: { ANTHROPIC_BASE_URL: 'https://a', ANTHROPIC_AUTH_TOKEN: 'k', KEEP: '1', CLAUDE_CODE_USE_BEDROCK: '1' },
    });
    expect(result.env).toEqual({ KEEP: '1' });
  });

  it('drops the env object entirely when nothing is left', () => {
    expect(clearProvider({ env: { ANTHROPIC_BASE_URL: 'https://a' } })).not.toHaveProperty('env');
  });
});

describe('replaceCredential / replaceModels', () => {
  it('keeps the variable the profile already uses', () => {
    const token = replaceCredential({ env: { ANTHROPIC_AUTH_TOKEN: 'old' } }, 'new');
    expect(token.variable).toBe('ANTHROPIC_AUTH_TOKEN');
    const key = replaceCredential({ env: { ANTHROPIC_API_KEY: 'old' } }, 'new');
    expect(key.variable).toBe('ANTHROPIC_API_KEY');
    expect((key.settings.env as Record<string, string>).ANTHROPIC_API_KEY).toBe('new');
  });

  it('updates both variables when they hold the same key', () => {
    const { settings } = replaceCredential({ env: { ANTHROPIC_AUTH_TOKEN: 'old', ANTHROPIC_API_KEY: 'old' } }, 'new');
    expect(settings.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'new', ANTHROPIC_API_KEY: 'new' });
  });

  it('leaves an intentionally empty API key alone', () => {
    const { settings } = replaceCredential({ env: { ANTHROPIC_AUTH_TOKEN: 'old', ANTHROPIC_API_KEY: '' } }, 'new');
    expect(settings.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'new', ANTHROPIC_API_KEY: '' });
  });

  it('only replaces models that were provided', () => {
    const result = replaceModels({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'a', ANTHROPIC_DEFAULT_SONNET_MODEL: 'b' } }, { sonnet: 'c' });
    expect(result.env).toMatchObject({ ANTHROPIC_DEFAULT_OPUS_MODEL: 'a', ANTHROPIC_DEFAULT_SONNET_MODEL: 'c' });
  });
});

describe('summarizeSettings', () => {
  it('detects the provider from the base URL and masks the key', () => {
    const summary = summarizeSettings({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic/',
        ANTHROPIC_AUTH_TOKEN: 'sk-abcdefghijklmnop',
        ANTHROPIC_MODEL: 'deepseek-flash[1m]',
      },
    });
    expect(summary.providerId).toBe('deepseek');
    expect(summary.maskedKey).toBe('...mnop');
    expect(JSON.stringify(summary)).not.toContain('abcdefghijklmnop');
    expect(summary.models.main).toBe('deepseek-flash[1m]');
  });

  it('reports plain Anthropic when no endpoint is configured', () => {
    expect(summarizeSettings({}).providerId).toBe('anthropic');
  });

  it('detects cloud platforms from their switches', () => {
    expect(summarizeSettings({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }).providerId).toBe('bedrock');
    expect(summarizeSettings({ env: { CLAUDE_CODE_USE_VERTEX: '1' } }).providerId).toBe('vertex');
    expect(summarizeSettings({ env: { CLAUDE_CODE_USE_FOUNDRY: '1' } }).providerId).toBe('foundry');
  });

  it('leaves unknown endpoints undetected', () => {
    const summary = summarizeSettings({ env: { ANTHROPIC_BASE_URL: 'https://unknown.example.com' } });
    expect(summary.providerId).toBeUndefined();
    expect(summary.baseUrl).toBe('https://unknown.example.com');
  });
});

describe('maskSecret', () => {
  it('never reveals short secrets', () => {
    expect(maskSecret('abc')).toBe('****');
    expect(maskSecret('12345678')).toBe('********');
  });
  it('shows only the tail of mid-length keys and the edges of long ones', () => {
    expect(maskSecret('sk-1234567890abcdef')).toBe('...cdef');
    expect(maskSecret('sk-ant-api03-1234567890abcdef')).toBe('sk-...cdef');
    expect(maskSecret(undefined)).toBeUndefined();
  });

  it('hides most of every key', () => {
    for (const length of [4, 8, 9, 11, 12, 15, 19, 20, 40]) {
      const key = 'k'.repeat(length - 4) + 'ABCD';
      const masked = maskSecret(key)!;
      const revealed = masked.replace(/[.*]/g, '').length;
      expect(revealed, `length ${length}`).toBeLessThanOrEqual(Math.ceil(length * 0.4));
    }
  });
});

describe('parseSettings', () => {
  it('does not echo file content in errors', () => {
    expect(() => parseSettings('{"ANTHROPIC_AUTH_TOKEN": "sk-super-secret-value" oops}')).toThrow(/not valid JSON/);
    try {
      parseSettings('{"ANTHROPIC_AUTH_TOKEN": "sk-super-secret-value" oops}');
    } catch (error) {
      expect((error as Error).message).not.toContain('sk-super-secret-value');
    }
  });

  it('rejects invalid JSON and non-objects with readable errors', () => {
    expect(() => parseSettings('{oops')).toThrow(/not valid JSON/);
    expect(() => parseSettings('[]')).toThrow(/JSON object/);
    expect(() => parseSettings('null')).toThrow(/JSON object/);
  });
});
