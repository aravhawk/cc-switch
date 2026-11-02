import { describe, expect, it } from 'vitest';
import { USER_OWNED_ENV_KEYS, applyProvider } from '../src/settings.js';
import { PROVIDERS, detectProvider, findProvider, resolveSelection } from '../src/providers/index.js';
import type { Provider } from '../src/providers/types.js';

const allEndpoints = PROVIDERS.flatMap(provider => provider.endpoints.map(endpoint => ({ provider, endpoint })));

function dummyEnvFor(provider: Provider): Record<string, string> {
  return Object.fromEntries((provider.fields ?? []).map(field => [field.env, 'value']));
}

describe('provider catalog', () => {
  it('has unique ids and aliases', () => {
    const seen = new Map<string, string>();
    for (const provider of PROVIDERS) {
      for (const name of [provider.id, ...(provider.aliases ?? [])].map(n => n.toLowerCase())) {
        expect(seen.get(name), `"${name}" is used by both ${seen.get(name)} and ${provider.id}`).toBeUndefined();
        seen.set(name, provider.id);
      }
    }
  });

  it('keeps the v3 template names working', () => {
    for (const legacy of ['anthropic', 'claude', 'moonshot', 'kimi', 'zai', 'glm', 'minimax']) {
      expect(findProvider(legacy), legacy).toBeDefined();
    }
  });

  it('uses well-formed base URLs without a /v1 suffix or credentials', () => {
    for (const { provider, endpoint } of allEndpoints) {
      if (provider.auth === 'native' && !endpoint.baseUrl) continue;
      const url = new URL(endpoint.baseUrl);
      expect(['http:', 'https:'], `${provider.id}/${endpoint.id}`).toContain(url.protocol);
      expect(url.pathname.replace(/\/+$/, ''), `${provider.id}/${endpoint.id} must not end in /v1`).not.toMatch(/\/v1$/);
      expect(url.username).toBe('');
      expect(url.search).toBe('');
      if (url.protocol === 'http:') {
        expect(['localhost', '127.0.0.1'], `${provider.id} uses plain http`).toContain(url.hostname);
      }
    }
  });

  it('has unique endpoint ids per provider', () => {
    for (const provider of PROVIDERS) {
      const ids = provider.endpoints.map(e => e.id);
      expect(new Set(ids).size, provider.id).toBe(ids.length);
    }
  });

  it('only uses HTTPS for remote providers', () => {
    for (const { provider, endpoint } of allEndpoints) {
      if (!endpoint.baseUrl) continue;
      const { protocol, hostname } = new URL(endpoint.baseUrl);
      if (protocol === 'http:') expect(['localhost', '127.0.0.1'], `${provider.id}/${endpoint.id}`).toContain(hostname);
    }
  });

  it('points every provider at documentation', () => {
    for (const provider of PROVIDERS) {
      expect(provider.docsUrl, provider.id).toMatch(/^https:\/\//);
    }
  });

  it('never leaks one provider\'s settings into the next', () => {
    const select = (provider: Provider, endpoint: string | undefined) =>
      resolveSelection({
        template: provider.id,
        endpoint,
        baseUrl: provider.id === 'custom' ? 'https://gateway.example.com' : undefined,
        models: provider.requiresModel ? { model: 'some-model' } : undefined,
        env: dummyEnvFor(provider),
      }).application;
    const targets = PROVIDERS.flatMap(p => (p.endpoints.length > 0 ? p.endpoints : [undefined]).map(e => ({ p, e: e?.id })));
    const userKeys = new Set(USER_OWNED_ENV_KEYS);
    const withoutUserKeys = (settings: Record<string, unknown>) =>
      Object.fromEntries(Object.entries((settings.env ?? {}) as Record<string, string>).filter(([k]) => !userKeys.has(k)));
    const start = { env: { KEEP_ME: '1' } };

    for (const first of targets) {
      const afterFirst = applyProvider(start, { ...select(first.p, first.e), apiKey: 'first-key-0123456789' });
      for (const second of targets) {
        const direct = applyProvider(start, { ...select(second.p, second.e), apiKey: 'second-key-0123456789' });
        const viaFirst = applyProvider(afterFirst, { ...select(second.p, second.e), apiKey: 'second-key-0123456789' });
        expect(withoutUserKeys(viaFirst), `${first.p.id}/${first.e} -> ${second.p.id}/${second.e}`).toEqual(withoutUserKeys(direct));
      }
    }
  });

  it('resolves and applies every provider endpoint', () => {
    for (const provider of PROVIDERS) {
      const endpoints = provider.endpoints.length > 0 ? provider.endpoints.map(e => e.id) : [undefined];
      for (const endpoint of endpoints) {
        const id = `${provider.id}/${endpoint ?? '-'}`;
        const selection = resolveSelection({
          template: provider.id,
          endpoint,
          baseUrl: provider.id === 'custom' ? 'https://gateway.example.com' : undefined,
          models: provider.requiresModel ? { model: 'some-model' } : undefined,
          env: dummyEnvFor(provider),
        });
        const settings = applyProvider({}, { ...selection.application, apiKey: 'test-key-123456' });
        const env = (settings.env ?? {}) as Record<string, string>;

        if (provider.auth === 'native') {
          expect(env.ANTHROPIC_BASE_URL, id).toBeUndefined();
        } else {
          expect(env.ANTHROPIC_BASE_URL, id).toBeTruthy();
          const credentialSet = Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY);
          expect(credentialSet, `${id} has no credential`).toBe(true);
        }
        // Every non-native provider must route all tiers to a model the endpoint knows, or the user must supply one.
        if (provider.auth !== 'native' && provider.id !== 'custom' && provider.category !== 'anthropic' && !provider.requiresModel) {
          expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? env.ANTHROPIC_MODEL, `${id} has no model`).toBeTruthy();
        }
      }
    }
  });

  it('round-trips: a profile written for a provider is detected as that provider', () => {
    for (const { provider, endpoint } of allEndpoints) {
      if (!endpoint.baseUrl) continue;
      const selection = resolveSelection({
        template: provider.id,
        endpoint: endpoint.id,
        models: provider.requiresModel ? { model: 'm' } : undefined,
        env: dummyEnvFor(provider),
      });
      const settings = applyProvider({}, { ...selection.application, apiKey: 'test-key-123456' });
      const detected = detectProvider(settings.env as Record<string, string>);
      // Providers may share a URL; the detected one must at least serve that URL.
      expect(detected, `${provider.id}/${endpoint.id}`).toBeDefined();
      expect(detected!.provider.endpoints.some(e => e.baseUrl === endpoint.baseUrl)).toBe(true);
    }
  });

  it('requires a model for hosts without defaults', () => {
    expect(() => resolveSelection({ template: 'ollama' })).toThrow(/--model/);
    expect(() => resolveSelection({ template: 'vllm' })).toThrow(/--model/);
  });

  it('requires a base URL for custom endpoints and validates it', () => {
    expect(() => resolveSelection({ template: 'custom' })).toThrow(/base URL/);
    expect(() => resolveSelection({ template: 'custom', baseUrl: 'ftp://x' })).toThrow(/http/);
    expect(() => resolveSelection({ template: 'custom', baseUrl: 'https://user:pass@x.example.com' })).toThrow(/credentials/);
  });

  it('requires cloud fields', () => {
    expect(() => resolveSelection({ template: 'vertex' })).toThrow(/ANTHROPIC_VERTEX_PROJECT_ID/);
    expect(() => resolveSelection({ template: 'foundry' })).toThrow(/ANTHROPIC_FOUNDRY_RESOURCE/);
    const vertex = resolveSelection({ template: 'vertex', env: { ANTHROPIC_VERTEX_PROJECT_ID: 'p' } });
    expect(vertex.application.env).toMatchObject({
      CLAUDE_CODE_USE_VERTEX: '1',
      ANTHROPIC_VERTEX_PROJECT_ID: 'p',
      CLOUD_ML_REGION: 'global',
    });
  });

  it('keeps the credential, endpoint and secrets out of --env', () => {
    for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY', '__proto__']) {
      expect(() => resolveSelection({ template: 'custom', baseUrl: 'https://a.example.com', env: { [name]: 'x' } }), name).toThrow();
    }
  });

  it('ignores blank --env values so field defaults still apply', () => {
    const { application } = resolveSelection({ template: 'vertex', env: { ANTHROPIC_VERTEX_PROJECT_ID: 'p', CLOUD_ML_REGION: '  ' } });
    expect(application.env.CLOUD_ML_REGION).toBe('global');
  });

  it('rejects --auth-style for templates that define their own credential', () => {
    expect(() => resolveSelection({ template: 'zai', authStyle: 'api-key' })).toThrow(/custom/);
  });

  it('makes ANTHROPIC_MODEL follow a tier override', () => {
    const { application } = resolveSelection({ template: 'moonshot-api', models: { sonnet: 'my-sonnet' } });
    expect(application.models.main).toBe('my-sonnet');
    const keepsMain = resolveSelection({ template: 'moonshot-api', models: { haiku: 'my-haiku' } });
    expect(keepsMain.application.models.main).toBe('kimi-k3[1m]');
  });

  it('treats "0" and "false" platform switches as off', () => {
    expect(detectProvider({ CLAUDE_CODE_USE_BEDROCK: '0' })?.provider.id).toBe('anthropic');
    expect(detectProvider({ CLAUDE_CODE_USE_BEDROCK: '1' })?.provider.id).toBe('bedrock');
  });

  it('applies --model to every tier and the subagent', () => {
    const { application } = resolveSelection({ template: 'deepseek', models: { model: 'deepseek-v4-pro' } });
    expect(application.models).toMatchObject({
      main: 'deepseek-v4-pro',
      opus: 'deepseek-v4-pro',
      sonnet: 'deepseek-v4-pro',
      haiku: 'deepseek-v4-pro',
      subagent: 'deepseek-v4-pro',
    });
  });

  it('lets a tier override beat the shared model', () => {
    const { application } = resolveSelection({ template: 'deepseek', models: { model: 'a', haiku: 'b' } });
    expect(application.models.haiku).toBe('b');
    expect(application.models.opus).toBe('a');
  });

  it('keeps the fable alias on a served model for third-party endpoints', () => {
    const { application } = resolveSelection({ template: 'zai' });
    expect(application.models.fable).toBe(application.models.opus);
  });

  it('applies endpoint-specific models and env', () => {
    const plan = resolveSelection({ template: 'alibaba', endpoint: 'token-plan' });
    expect(plan.application.models.opus).toBe('qwen3.8-max');
    expect(plan.application.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('983616');
    const payg = resolveSelection({ template: 'alibaba', endpoint: 'payg-intl' });
    expect(payg.application.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  });

  it('rejects unknown providers and endpoints with a helpful message', () => {
    expect(() => resolveSelection({ template: 'nope' })).toThrow(/--providers/);
    expect(() => resolveSelection({ template: 'zai', endpoint: 'mars' })).toThrow(/global, china/);
  });
});

describe('documentation', () => {
  it('lists every provider template in the README', async () => {
    const { readFile } = await import('node:fs/promises');
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf-8');
    for (const provider of PROVIDERS) {
      expect(readme, `README is missing \`${provider.id}\``).toContain(`\`${provider.id}\``);
    }
  });
});
