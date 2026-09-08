import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { agentKind, type AgentInfo, type AgentQueueItem } from '../shared/types';

export type StoredClaudeQueue = AgentQueueItem & { attempts: number; next_attempt_at: number; session?: string; persisted?: boolean };
/** Unidentified sessions are usable only in the bridge process that observed them. */
export function claudeQueueIdentity(agent: AgentInfo, epoch: number) {
  return agent.agent_session?.value
    ? JSON.stringify(['session', agentKind(agent), agent.agent_session.kind, agent.agent_session.value])
    : JSON.stringify(['live', epoch, agentKind(agent), agent.pane_id, agent.name, agent.cwd]);
}
export function restoredClaudeQueue(item: StoredClaudeQueue): StoredClaudeQueue {
  return { ...item, persisted: true, next_attempt_at: 0,
    state: !item.session || item.state === 'failed' ? 'failed' : 'queued',
    ...(!item.session ? { error: 'This saved prompt has no verified agent session. Inspect the agent before queueing it again.' } : {}) };
}
/** Capture each snapshot and serialize durable writes without blocking the bridge event loop. */
export class ClaudeQueueFile {
  private tail: Promise<void> = Promise.resolve();
  constructor(private directory?: string) {}
  write(snapshot: unknown) {
    if (!this.directory) return Promise.resolve();
    const data = JSON.stringify(snapshot), file = join(this.directory, 'claude-queue.json');
    const write = this.tail.then(async () => {
      await mkdir(this.directory!, { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, file);
        const directory = await open(this.directory!, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await unlink(temp).catch(() => {}); }
    });
    this.tail = write.catch(() => {}); return write;
  }
}
