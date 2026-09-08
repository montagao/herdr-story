import type { StudioState } from '../shared/studio';
import type { OfficeClient } from './net/office-client';

export type PendingStudioSave = { id: string; lane: string; params: Record<string, unknown>; at: number; state: 'saving' | 'slow' | 'uncertain'; draft?: { key: string; fingerprint: string } };
function browserStorage() { try { return globalThis.localStorage; } catch { return undefined; } }
const KEY = 'herdr-story:pending-studio-saves:v1';
/** Save receipts survive refreshes. Uncertain writes are checked before any explicit retry. */
export class StudioSaves {
  readonly pending = new Map<string, PendingStudioSave>();
  onChange = () => {};
  onConfirmed = (_item: PendingStudioSave, _state: StudioState) => {};
  constructor(private client: OfficeClient, private storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = browserStorage()) {
    try {
      const saved = JSON.parse(storage?.getItem(KEY) || '[]');
      if (Array.isArray(saved)) for (const item of saved.slice(0, 100)) {
        if (item && typeof item.id === 'string' && typeof item.lane === 'string' && item.params && typeof item.params.op === 'string') this.pending.set(item.lane, { ...item, state: 'uncertain' });
      }
    } catch { /* Private browsing or damaged local drafts. */ }
  }
  private publish() {
    try { this.storage?.setItem(KEY, JSON.stringify([...this.pending.values()])); } catch { /* Keep the in-memory copy. */ }
    this.onChange();
  }
  private clear(item: PendingStudioSave) { if (this.pending.get(item.lane) === item) this.pending.delete(item.lane); this.publish(); }
  async save(params: Record<string, unknown>, lane: string, draft?: PendingStudioSave['draft']): Promise<StudioState> {
    if (this.pending.has(lane)) throw new Error('Check the previous save for this item before saving it again.');
    const item: PendingStudioSave = { id: `${Date.now()}-${crypto.randomUUID()}`, lane, params, draft, at: Date.now(), state: 'saving' };
    this.pending.set(lane, item); this.publish();
    return this.send(item);
  }
  private async send(item: PendingStudioSave): Promise<StudioState> {
    item.state = 'saving'; this.publish();
    const slow = setTimeout(() => { item.state = 'slow'; this.publish(); }, 1500);
    try {
      const result = await this.client.call('studio.change', { ...item.params, action_id: item.id }, { timeoutMs: 10_000 }) as StudioState;
      this.onConfirmed(item, result); this.clear(item); return result;
    } catch (error) {
      if (!(error as { uncertain?: boolean }).uncertain) { this.clear(item); throw error; }
      // The commit may have succeeded while its reply was lost. Never turn that into a second edit.
      try {
        const status = await this.client.call('studio.action.status', { id: item.id }, { timeoutMs: 3000 }) as { state: string };
        if (status.state === 'confirmed') return await this.confirmed(item);
      } catch { /* Keep the receipt available for Check saves. */ }
      item.state = 'uncertain'; this.publish();
      throw new Error('Save not confirmed. Your edit is kept; use Check saves when the connection returns.');
    } finally { clearTimeout(slow); }
  }
  private async confirmed(item: PendingStudioSave) {
    const state = await this.client.call('studio.get', { compact: true }, { timeoutMs: 5000 }) as StudioState;
    this.onConfirmed(item, state); this.clear(item); return state;
  }
  async check(item: PendingStudioSave, retry = false): Promise<StudioState | undefined> {
    if (item.state === 'saving' || item.state === 'slow') return;
    const status = await this.client.call('studio.action.status', { id: item.id }, { timeoutMs: 3000 }) as { state: string };
    if (status.state === 'confirmed') return this.confirmed(item);
    if (status.state === 'pending') throw new Error('The bridge is still saving this edit. Check again shortly.');
    if (retry) return this.send(item);
    throw new Error('The bridge has not confirmed this edit. Retry saved edits to send it with the same save ID.');
  }
}
