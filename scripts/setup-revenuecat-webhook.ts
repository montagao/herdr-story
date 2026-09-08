// Prepare the private receiver config; --register also creates this app's RevenueCat integration.
// Never prints credentials and never changes any other webhook integration.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REVENUECAT_WEBHOOK_PATH } from '../bridge/revenuecat-webhook';
import { registerRevenueCatWebhook } from '../bridge/revenuecat-registration';

const args = process.argv.slice(2);
const arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const publicUrl = arg('--url') || process.env.REVENUECAT_WEBHOOK_PUBLIC_URL;
if (!publicUrl) throw new Error('Pass --url https://your-public-host/webhooks/revenuecat (proxy only the dedicated webhook port).');
const url = new URL(publicUrl);
if (url.protocol !== 'https:' || url.pathname !== REVENUECAT_WEBHOOK_PATH || url.username || url.password || url.search || url.hash)
  throw new Error('Use an HTTPS URL ending in /webhooks/revenuecat, with no credentials or query string.');
const port = Number(arg('--port') || process.env.HERDR_STORY_WEBHOOK_PORT || 7789);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === Number(process.env.HERDR_STORY_PORT || 7788))
  throw new Error('Choose a separate webhook port between 1024 and 65535.');
const authorization = process.env.REVENUECAT_WEBHOOK_AUTH || `Bearer ${randomBytes(32).toString('hex')}`;
const envPath = join(process.cwd(), '.env');
function save(values: Record<string, string>) {
  let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key}=.*$`, 'm'), line = `${key}=${JSON.stringify(value)}`;
    text = re.test(text) ? text.replace(re, () => line) : `${text.trimEnd()}\n${line}\n`;
  }
  const temp = `${envPath}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, envPath);
}
save({ HERDR_STORY_WEBHOOK_PORT: String(port), REVENUECAT_WEBHOOK_AUTH: authorization, REVENUECAT_WEBHOOK_PUBLIC_URL: url.href });
console.log(`Webhook receiver configured on 127.0.0.1:${port}. Restart the bridge after setup.`);

if (args.includes('--register')) {
  const key = process.env.REVENUECAT_API_KEY || process.env.REVENUECAT_SECRET_KEY;
  if (!key) throw new Error('Set REVENUECAT_API_KEY first.');
  let project = process.env.REVENUECAT_PROJECT_ID;
  if (!project) {
    const response = await fetch('https://api.revenuecat.com/v2/projects', {
      headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('Set REVENUECAT_PROJECT_ID or grant Projects → Read on the key.');
    project = ((await response.json()) as { items?: { id: string }[] }).items?.[0]?.id;
  }
  if (!project) throw new Error('Set REVENUECAT_PROJECT_ID.');
  const integration = await registerRevenueCatWebhook({ key, project, url: url.href, authorization });
  const values: Record<string, string> = { REVENUECAT_WEBHOOK_INTEGRATION_ID: integration.id };
  if (integration.signingSecret) values.REVENUECAT_WEBHOOK_SIGNING_SECRET = integration.signingSecret;
  save(values);
  console.log(`Registered herdr-story payments for project ${project}: ${url.href}`);
  console.log('Other integrations are unchanged. Credentials are saved only in .env. Restart the bridge to load them.');
}
