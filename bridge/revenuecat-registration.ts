interface Integration { id: string; name: string; url: string; environment: string; signing_secret?: string }

/** TLS terminates at Tailscale Serve; the browser origin is HTTPS while Bun receives HTTP. */
export function webhookSetupOriginAllowed(req: Request) {
  const origin = req.headers.get('origin');
  if (!origin) return true; // local CLI
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin
      && parsed.host === new URL(req.url).host;
  } catch { return false; }
}

/** Create only this game's integration. Never repurpose another service's webhook. */
export async function registerRevenueCatWebhook(options: {
  key: string; project: string; url: string; authorization: string; fetch?: typeof fetch;
}): Promise<{ id: string; signingSecret?: string }> {
  const request = options.fetch ?? fetch;
  const call = async (path: string, body?: unknown): Promise<any> => {
    const res = await request(`https://api.revenuecat.com/v2${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${options.key}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(res.status === 403
      ? 'RevenueCat needs Integrations → Read & Write (project_configuration:integrations:read_write) on this API key. Enable it, then try again.'
      : `RevenueCat returned HTTP ${res.status}. Please retry.`);
    return res.json();
  };
  const path = `/projects/${encodeURIComponent(options.project)}/integrations/webhooks`;
  const all: Integration[] = [];
  let next: string | null = `${path}?limit=100`;
  const seen = new Set<string>();
  while (next) {
    if (!next.startsWith(`${path}?`) || seen.has(next)) throw new Error('Unexpected RevenueCat pagination URL.');
    seen.add(next);
    const page = await call(next); all.push(...(page.items || []));
    next = page.next_page ? String(page.next_page).replace(/^\/v2/, '') : null;
  }
  const name = 'herdr-story payments';
  const existing = all.find(i => i.name === name && i.url === options.url);
  const integration: Integration = await call(existing ? `${path}/${encodeURIComponent(existing.id)}` : path, {
    name, url: options.url, authorization_header: options.authorization, environment: 'production', event_types: null, app_id: null,
  });
  if (!integration.id) throw new Error('RevenueCat did not return an integration id.');
  const confirmed: Integration = await call(`${path}/${encodeURIComponent(integration.id)}`);
  if (confirmed.url !== options.url || confirmed.environment !== 'production' || confirmed.name !== name)
    throw new Error('Webhook readback did not match the requested configuration.');
  return { id: integration.id, signingSecret: integration.signing_secret };
}
