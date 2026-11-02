import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { needsInsecureTransportWarning, stripContextSuffix, testConnection, validateBaseUrl } from '../src/connection-test.js';

let server: Server;
let base: string;
const seen: Array<{ url?: string; headers: IncomingMessage['headers']; body: any }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ url: req.url, headers: req.headers, body });
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url?.startsWith('/redirect')) {
        res.writeHead(302, { location: 'http://other.invalid/' });
        return res.end();
      }
      if (req.url !== '/v1/messages') return json(404, { error: { message: 'no route' } });
      const authorized = req.headers.authorization === 'Bearer good' || req.headers['x-api-key'] === 'good';
      if (!authorized) return json(401, { error: { message: 'bad key bad-secret-value' } });
      if (body.model === 'forced-thinking') return json(400, { error: { message: 'only type=enabled is allowed' } });
      if (body.model === 'missing') return json(404, { error: { message: 'model not found' } });
      return json(200, { type: 'message', content: [{ type: 'text', text: 'ok' }] });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('testConnection', () => {
  it('succeeds with a bearer token and strips the [1m] hint from the model', async () => {
    seen.length = 0;
    const result = await testConnection({ baseUrl: `${base}/`, apiKey: 'good', credential: 'ANTHROPIC_AUTH_TOKEN', models: { haiku: 'cheap[1m]', sonnet: 'big' } });
    expect(result.status).toBe('ok');
    expect(seen[0]!.url).toBe('/v1/messages');
    expect(seen[0]!.body.model).toBe('cheap');
    expect(seen[0]!.body.max_tokens).toBeLessThanOrEqual(32);
    expect(seen[0]!.headers['anthropic-version']).toBeTruthy();
  });

  it('sends ANTHROPIC_API_KEY credentials as x-api-key', async () => {
    seen.length = 0;
    const result = await testConnection({ baseUrl: base, apiKey: 'good', credential: 'ANTHROPIC_API_KEY', models: { main: 'm' } });
    expect(result.status).toBe('ok');
    expect(seen[0]!.headers['x-api-key']).toBe('good');
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  it('reports a rejected key without echoing the key', async () => {
    const result = await testConnection({ baseUrl: base, apiKey: 'bad-secret-value', credential: 'ANTHROPIC_AUTH_TOKEN', models: { main: 'm' } });
    expect(result.status).toBe('auth-failed');
    expect(result.httpStatus).toBe(401);
    expect(result.message).not.toContain('bad-secret-value');
  });

  it('reports unknown models and routes as not-found', async () => {
    const model = await testConnection({ baseUrl: base, apiKey: 'good', models: { main: 'missing' } });
    expect(model.status).toBe('not-found');
    const route = await testConnection({ baseUrl: `${base}/wrong`, apiKey: 'good', models: { main: 'm' } });
    expect(route.status).toBe('not-found');
  });

  it('treats other server errors as reachable, with the server\'s explanation', async () => {
    const result = await testConnection({ baseUrl: base, apiKey: 'good', models: { main: 'forced-thinking' } });
    expect(result.status).toBe('reachable');
    expect(result.message).toContain('only type=enabled');
  });

  it('never follows redirects with the key', async () => {
    seen.length = 0;
    const result = await testConnection({ baseUrl: `${base}/redirect`, apiKey: 'good', models: { main: 'm' } });
    expect(result.status).toBe('unreachable');
    expect(result.message).toMatch(/redirect/);
    expect(seen).toHaveLength(1);
  });

  it('reports connection failures', async () => {
    const result = await testConnection({ baseUrl: 'http://127.0.0.1:1', apiKey: 'good', models: { main: 'm' }, timeoutMs: 2000 });
    expect(result.status).toBe('unreachable');
  });

  it('strips terminal control characters from server messages', async () => {
    const evil = createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom \u001b]0;pwned\u0007\u001b[31mred' } }));
    });
    await new Promise<void>(resolve => evil.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(evil.address() as AddressInfo).port}`;
      const result = await testConnection({ baseUrl: url, apiKey: 'k', models: { main: 'm' } });
      // eslint-disable-next-line no-control-regex
      expect(result.message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
      expect(result.message).toContain('boom');
    } finally {
      await new Promise<void>(resolve => evil.close(() => resolve()));
    }
  });

  it('skips profiles without a custom endpoint or model', async () => {
    expect((await testConnection({ models: {} })).status).toBe('skipped');
    expect((await testConnection({ baseUrl: base, models: {} })).status).toBe('skipped');
  });
});

describe('URL helpers', () => {
  it('validates base URLs', () => {
    expect(validateBaseUrl('https://api.example.com/anthropic')).toBeUndefined();
    expect(validateBaseUrl('http://localhost:11434')).toBeUndefined();
    expect(validateBaseUrl('example.com')).toMatch(/valid URL/);
    expect(validateBaseUrl('file:///etc/passwd')).toMatch(/http/);
    expect(validateBaseUrl('https://u:p@example.com')).toMatch(/credentials/);
  });

  it('flags plain http except to loopback', () => {
    expect(needsInsecureTransportWarning('http://example.com')).toBe(true);
    expect(needsInsecureTransportWarning('http://localhost:8080')).toBe(false);
    expect(needsInsecureTransportWarning('http://127.0.0.1:8080')).toBe(false);
    expect(needsInsecureTransportWarning('http://[::1]:8080')).toBe(false);
    expect(needsInsecureTransportWarning('https://example.com')).toBe(false);
    // Hostnames that merely start with 127. are not loopback.
    expect(needsInsecureTransportWarning('http://127.attacker.com')).toBe(true);
    expect(needsInsecureTransportWarning('http://127.0.0.1.evil.net')).toBe(true);
  });

  it('strips only a trailing context suffix', () => {
    expect(stripContextSuffix('glm-5.3[1m]')).toBe('glm-5.3');
    expect(stripContextSuffix('plain')).toBe('plain');
  });
});
