import { expect, test } from 'bun:test';
import { registerRevenueCatWebhook, webhookSetupOriginAllowed } from './revenuecat-registration';

const url = 'https://hooks.example.test/webhooks/revenuecat';
const options = { key: 'private-test-key', authorization: 'Bearer private-test-header', project: 'project1', url };
test('private setup accepts the same host behind TLS termination and rejects foreign/null origins', () => {
  const request = (origin: string) => new Request('http://office.tailnet.ts.net/api/revenuecat/webhook', { headers: { origin } });
  expect(webhookSetupOriginAllowed(request('https://office.tailnet.ts.net'))).toBe(true);
  expect(webhookSetupOriginAllowed(request('https://evil.example'))).toBe(false);
  expect(webhookSetupOriginAllowed(request('https://office.tailnet.ts.net:8443'))).toBe(false);
  expect(webhookSetupOriginAllowed(request('null'))).toBe(false);
});
test('registration creates a separate production webhook and verifies it', async () => {
  const calls: { path: string; method: string; body?: any }[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input), method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, method, body });
    if (path.includes('?limit=')) return Response.json({ items: [{ id: 'existing-billing', name: 'Billing sync', url: 'https://billing.example.test' }] });
    return Response.json({ id: 'new-game', name: 'herdr-story payments', url, environment: 'production', signing_secret: 'private-signing-secret' });
  }) as typeof fetch;
  expect(await registerRevenueCatWebhook({ ...options, fetch: fake })).toEqual({ id: 'new-game', signingSecret: 'private-signing-secret' });
  expect(calls[1].path).toEndWith('/integrations/webhooks');
  expect(calls[1].body).toMatchObject({ authorization_header: options.authorization, environment: 'production', name: 'herdr-story payments' });
  expect(calls.some(c => c.path.includes('existing-billing'))).toBe(false);
  expect(calls[2].method).toBe('GET');
});
test('matching name and URL are required to reuse a configuration', async () => {
  const writes: string[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.includes('?limit=')) return Response.json({ items: [
      { id: 'other-host', name: 'herdr-story payments', url: 'https://other.example.test' },
      { id: 'our-game', name: 'herdr-story payments', url },
    ] });
    if (init?.method === 'POST') writes.push(path);
    return Response.json({ id: 'our-game', name: 'herdr-story payments', url, environment: 'production' });
  }) as typeof fetch;
  await registerRevenueCatWebhook({ ...options, fetch: fake });
  expect(writes).toHaveLength(1); expect(writes[0]).toEndWith('/our-game');
});
test('insufficient scope produces a fixable error without exposing credentials', async () => {
  const fake = (async () => new Response('', { status: 403 })) as unknown as typeof fetch;
  await expect(registerRevenueCatWebhook({ ...options, fetch: fake })).rejects.toThrow('Integrations → Read & Write');
});
