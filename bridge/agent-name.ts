/** Herdr's agent.start identifier contract; office display names are stored separately. */
export const validAgentName = (name: string) => /^[a-z][a-z0-9_-]{0,31}$/.test(name);

export function agentLaunchName(displayName: string, occupied: Iterable<string> = []): string {
  let base = displayName.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) base = 'agent';
  else if (!/^[a-z]/.test(base)) base = `agent-${base}`;
  base = base.slice(0, 32).replace(/[-_]+$/, '');
  const used = new Set(occupied);
  let name = base;
  for (let n = 2; used.has(name); n++) {
    const suffix = `-${n}`;
    name = base.slice(0, 32 - suffix.length).replace(/[-_]+$/, '') + suffix;
  }
  return name;
}
