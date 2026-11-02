export type ConnectionStatus = 'ok' | 'reachable' | 'auth-failed' | 'not-found' | 'unreachable' | 'skipped';

export interface ConnectionTestResult {
  status: ConnectionStatus;
  /** One-line, human-readable explanation. Never contains the API key. */
  message: string;
  httpStatus?: number;
  model?: string;
}

export interface ConnectionTestInput {
  baseUrl?: string;
  apiKey?: string;
  credential?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  models: { main?: string; haiku?: string; sonnet?: string; opus?: string };
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Claude Code's `[1m]` suffix is a client-side context hint and is not part of the real model ID. */
export function stripContextSuffix(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '');
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Returns an error message when `value` is not an acceptable ANTHROPIC_BASE_URL. */
export function validateBaseUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `"${value}" is not a valid URL`;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'Base URL must start with http:// or https://';
  }
  if (url.username || url.password) {
    return 'Base URL must not contain credentials; pass the API key separately';
  }
  return undefined;
}

export function needsInsecureTransportWarning(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' && !isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function pickModel(models: ConnectionTestInput['models']): string | undefined {
  // Prefer the cheapest tier: this is only a reachability probe.
  const chosen = models.haiku ?? models.sonnet ?? models.main ?? models.opus;
  return chosen ? stripContextSuffix(chosen) : undefined;
}

/** Server-supplied text is untrusted: drop control characters so it cannot inject terminal escape sequences. */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const candidate =
      typeof parsed.error === 'string'
        ? parsed.error
        : typeof parsed.error?.message === 'string'
          ? parsed.error.message
          : typeof parsed.message === 'string'
            ? parsed.message
            : undefined;
    return candidate ? sanitize(candidate).slice(0, 200) : undefined;
  } catch {
    return sanitize(body).slice(0, 120) || undefined;
  }
}

function redact(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

/**
 * Send one tiny Messages API request to the profile's endpoint to verify URL, key and model.
 * The key is only ever sent to the profile's own base URL; redirects are not followed so it
 * cannot be forwarded elsewhere.
 */
export async function testConnection(input: ConnectionTestInput): Promise<ConnectionTestResult> {
  if (!input.baseUrl) {
    return { status: 'skipped', message: 'This profile talks to Claude directly, so there is no custom endpoint to test.' };
  }
  const urlProblem = validateBaseUrl(input.baseUrl);
  if (urlProblem) return { status: 'unreachable', message: urlProblem };

  const model = pickModel(input.models);
  if (!model) {
    return { status: 'skipped', message: 'No model is configured for this profile, so there is nothing to probe.' };
  }

  const endpoint = `${input.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (input.apiKey) {
    if (input.credential === 'ANTHROPIC_API_KEY') headers['x-api-key'] = input.apiKey;
    else headers.authorization = `Bearer ${input.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      }),
    });
  } catch (error) {
    const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      status: 'unreachable',
      message: timedOut
        ? `No response from ${new URL(endpoint).host} within ${Math.round((input.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s.`
        : `Could not connect to ${new URL(endpoint).host}: ${redact(reason, input.apiKey)}`,
      model,
    };
  }

  const httpStatus = response.status;
  const bodyText = await response.text().catch(() => '');
  const detail = extractErrorMessage(redact(bodyText, input.apiKey));

  if (httpStatus >= 200 && httpStatus < 300) {
    return { status: 'ok', message: `Endpoint accepted the key and answered with model "${model}".`, httpStatus, model };
  }
  if (httpStatus >= 300 && httpStatus < 400) {
    return {
      status: 'unreachable',
      message: `The endpoint redirected (HTTP ${httpStatus}). Check the base URL; cc-switch will not forward your key to a redirect target.`,
      httpStatus,
      model,
    };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      status: 'auth-failed',
      message: `The endpoint rejected the credential (HTTP ${httpStatus})${detail ? `: ${detail}` : ''}. Check the API key and that it matches this region or plan.`,
      httpStatus,
      model,
    };
  }
  if (httpStatus === 404) {
    return {
      status: 'not-found',
      message: `HTTP 404${detail ? `: ${detail}` : ''}. The base URL or the model "${model}" is not available on this endpoint.`,
      httpStatus,
      model,
    };
  }
  // 400/422/429/5xx: the server is there and spoke Messages API; report what it said.
  return {
    status: 'reachable',
    message: `Endpoint is reachable but returned HTTP ${httpStatus}${detail ? `: ${detail}` : ''}.`,
    httpStatus,
    model,
  };
}
