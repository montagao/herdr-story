/** Browser isolation for a local control plane. This is not user authentication. */
export function browserAccess(options: { port: number; host: string; origins?: string }) {
  const origins = new Set<string>();
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    for (const port of [options.port, 5173]) origins.add(`http://${host}:${port}`);
  }
  for (const value of (options.origins ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value)
      throw new Error('HERDR_STORY_ALLOWED_ORIGINS must contain exact HTTP(S) origins, without paths or trailing slashes.');
    origins.add(value);
  }
  const hosts = new Set([...origins].map(origin => new URL(origin).host));
  // Explicit direct binds remain usable by CLI clients; browser access needs a listed origin.
  if (!['0.0.0.0', '::'].includes(options.host))
    hosts.add(`${options.host.includes(':') ? `[${options.host}]` : options.host}:${options.port}`);
  return (req: Request) => {
    // Checking Host as well as Origin blocks DNS rebinding to the loopback listener.
    if (!hosts.has(new URL(req.url).host) || !hosts.has((req.headers.get('host') ?? new URL(req.url).host).toLowerCase())) return false;
    const origin = req.headers.get('origin');
    if (origin !== null) return origins.has(origin);
    // Non-browser CLI clients omit both headers. A foreign browser cannot use a no-CORS
    // request to bypass the origin check (including image uploads and setup endpoints).
    return !['cross-site', 'same-site'].includes(req.headers.get('sec-fetch-site') ?? '');
  };
}
