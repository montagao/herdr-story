interface Status {
  enabled: boolean; listening: boolean; url: string | null; integrationId: string | null;
  lastReceivedAt: number | null; lastTestAt: number | null; lastNotificationAt: number | null;
  pending: number | null;
}

/** A small status panel inside the existing game-styled payment settings. */
export function mountRevenueCatWebhook(root: HTMLElement, writable: boolean) {
  root.innerHTML = `<h3><i>3</i>Payment notifications</h3>
    <p>Purchases and renewals appear in Sales and bring coins into the office. Trials, cancellations,
       refunds and billing issues get their own notifications.</p>
    <p class="setup-hook-status" role="status">Checking webhook connection…</p>
    <p><button type="button" class="setup-hook-register copy-inline" hidden>Connect notifications in RevenueCat</button></p>
    <p class="setup-hook-registration-status setup-hint" role="status"></p>
    <div class="setup-hook-details" hidden>
      <p class="setup-hint">RevenueCat → Integrations → Webhooks. Use this URL, the authorization header below,
        and Production events. Send a test event to check the connection.</p>
      <div class="setup-copy"><code class="setup-hook-url"></code><button type="button" class="setup-hook-copy-url">Copy URL</button></div>
      <p><button type="button" class="setup-hook-copy-auth copy-inline">Copy authorization header</button></p>
      <p class="setup-hook-feedback setup-hint" role="status"></p>
    </div>
    <p class="setup-hint">Retries are deduplicated and the event log survives restarts. Test and sandbox events
       never count as sales. Revenue totals still come from the metrics API.</p>`;
  let status: Status | undefined, disposed = false;
  const message = root.querySelector<HTMLElement>('.setup-hook-status')!;
  const feedback = root.querySelector<HTMLElement>('.setup-hook-feedback')!;
  const auth = root.querySelector<HTMLButtonElement>('.setup-hook-copy-auth')!;
  const register = root.querySelector<HTMLButtonElement>('.setup-hook-register')!;
  const registrationStatus = root.querySelector<HTMLElement>('.setup-hook-registration-status')!;
  auth.hidden = !writable;
  register.addEventListener('click', async () => {
    register.disabled = true; registrationStatus.textContent = 'Connecting to RevenueCat…';
    try {
      const res = await fetch('/api/revenuecat/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'register' }) });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error || 'Could not register the webhook.');
      registrationStatus.textContent = 'Connected. New production payments will appear automatically.';
      await poll();
    } catch (e) { registrationStatus.textContent = (e as Error).message; }
    finally { register.disabled = false; }
  });
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); feedback.textContent = 'Copied.'; }
    catch { feedback.textContent = 'Clipboard unavailable. Open the office over HTTPS to copy.'; }
  };
  root.querySelector('.setup-hook-copy-url')!.addEventListener('click', () => { if (status?.url) void copy(status.url); });
  auth.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/revenuecat/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = await res.json() as { authorization?: string; error?: string };
      if (!res.ok || !body.authorization) throw new Error(body.error || 'Authorization header is not configured.');
      await copy(body.authorization);
    } catch (e) { feedback.textContent = (e as Error).message; }
  });
  const poll = async () => {
    try {
      const res = await fetch('/api/revenuecat/webhook');
      if (!res.ok) throw new Error('Could not check webhook connection.');
      const next = await res.json() as Status;
      if (disposed) return;
      status = next;
      register.hidden = !writable || !next.listening || !next.url || Boolean(next.integrationId);
      const details = root.querySelector<HTMLElement>('.setup-hook-details')!;
      details.hidden = !next.url;
      root.querySelector('.setup-hook-url')!.textContent = next.url;
      const date = (at: number) => new Date(at).toLocaleString();
      message.textContent = !next.enabled || !next.listening
        ? 'Notifications need a webhook receiver. Run the webhook setup in the README, then restart the bridge.'
        : next.pending ? `${next.pending} saved notification${next.pending === 1 ? '' : 's'} waiting to process.`
        : next.lastNotificationAt ? `Receiving events · last notification ${date(next.lastNotificationAt)}`
        : next.lastTestAt ? `Test received ${date(next.lastTestAt)} · waiting for a production payment.`
        : next.integrationId ? 'Registered with RevenueCat · waiting for the first event.'
        : 'Receiver ready · add it in RevenueCat and send a test event.';
    } catch { if (!disposed) message.textContent = 'Could not check webhook connection. Retrying…'; }
  };
  void poll();
  const timer = window.setInterval(() => void poll(), 3000);
  return () => { disposed = true; clearInterval(timer); };
}
