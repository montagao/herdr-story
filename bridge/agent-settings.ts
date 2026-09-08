import { CLAUDE_EFFORTS, CODEX_EFFORTS, type AgentSettingsOptions } from '../shared/agent-settings';
import { fileURLToPath } from 'node:url';

/** Node's ws implementation supports Codex's Unix WebSocket transport; Bun's substitute does not. */
export async function codexSettingsCall(method: string, params: Record<string, unknown>): Promise<any> {
  const proc = Bun.spawn(['node', fileURLToPath(new URL('./codex-settings.mjs', import.meta.url))], { env: { ...process.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), 12_000);
  try {
    proc.stdin.write(JSON.stringify({ method, params }));
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(stderr.trim() || 'Codex settings connection timed out. Use Open terminal picker instead.');
    return JSON.parse(stdout);
  } finally { clearTimeout(timer); proc.kill(); }
}

let catalog: { at: number; options: AgentSettingsOptions } | undefined;
export async function agentSettingsOptions(kind: string): Promise<AgentSettingsOptions> {
  if (kind === 'claude') return { models: ['sonnet', 'opus', 'haiku', 'fable'].map(id => ({ id, label: id, efforts: id === 'haiku' ? [] : CLAUDE_EFFORTS })), efforts: CLAUDE_EFFORTS };
  if (kind !== 'codex') return { models: [], efforts: [] };
  if (catalog && Date.now() - catalog.at < 60_000) return catalog.options;
  const options: AgentSettingsOptions = { models: [], efforts: CODEX_EFFORTS };
  try {
    const proc = Bun.spawn(['codex', 'debug', 'models', '--bundled'], { stdout: 'pipe', stderr: 'ignore' });
    const timer = setTimeout(() => proc.kill(), 5000);
    try {
      const raw = await new Response(proc.stdout).json() as any;
      if (await proc.exited === 0) options.models = (raw.models ?? []).filter((m: any) => m.visibility === 'list').map((m: any) => ({ id: m.slug, label: m.display_name || m.slug, efforts: (m.supported_reasoning_levels ?? []).map((e: any) => e.effort).filter((e: string) => CODEX_EFFORTS.includes(e)) }));
    } finally { clearTimeout(timer); proc.kill(); }
  } catch { /* Older Codex builds can still accept an explicit model ID. */ }
  catalog = { at: Date.now(), options };
  return options;
}
