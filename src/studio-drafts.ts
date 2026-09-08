export type DraftContext = { kind: 'project' | 'goal' | 'entry' | 'employee' | 'room'; id?: string; project?: string; release?: boolean; version?: number; title: string };
type Field = { name: string; type: string; value: string; checked?: boolean };
export type StudioDraft = { key: string; context: DraftContext; at: number; fields?: Field[]; steps?: { id: string; text: string; done: boolean }[]; room?: { items: unknown[]; order: string[] } };
const KEY = 'herdr-story:studio-drafts:v1';
export class StudioDrafts {
  records = new Map<string, StudioDraft>();
  onChange = () => {};
  private timer?: ReturnType<typeof setTimeout>;
  private awaitingRestore = new WeakSet<HTMLFormElement>();
  private baselines = new WeakMap<HTMLFormElement, string>();
  private contexts = new WeakMap<HTMLFormElement, { key: string; context: DraftContext }>();
  constructor() {
    if (typeof addEventListener !== 'undefined') addEventListener('pagehide', () => this.flush());
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (Array.isArray(saved)) for (const item of saved) if (typeof item?.key === 'string' && item.context?.kind) this.records.set(item.key, item);
    } catch { /* Storage may be unavailable. */ }
  }
  flush() { clearTimeout(this.timer); this.timer = undefined; try { localStorage.setItem(KEY, JSON.stringify([...this.records.values()])); } catch { /* Preserve the in-memory draft. */ } }
  private persist() { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 120); this.onChange(); }
  receipt(form: HTMLFormElement) { const record = this.contexts.get(form); return record ? { key: record.key, fingerprint: JSON.stringify(this.snapshot(form)) } : undefined; }
  confirmed(key: string, fingerprint: string, forms: HTMLFormElement[]) {
    const draft = this.records.get(key);
    if (draft && JSON.stringify({ fields: draft.fields, steps: draft.steps }) === fingerprint) this.remove(key);
    for (const form of forms) if (this.contexts.get(form)?.key === key && JSON.stringify(this.snapshot(form)) === fingerprint) this.baselines.set(form, fingerprint);
  }
  put(draft: StudioDraft) { const previous = this.records.get(draft.key); if (previous && JSON.stringify({ ...previous, at: 0 }) === JSON.stringify({ ...draft, at: 0 })) return; this.records.set(draft.key, draft); this.persist(); }
  remove(key: string) { this.records.delete(key); this.persist(); }
  snapshot(form: HTMLFormElement) {
    const fields = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input[name],textarea[name],select[name]')].map(el => ({ name: el.name, type: el.type, value: el.value, ...(el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type) ? { checked: el.checked } : {}) }));
    const steps = [...form.querySelectorAll<HTMLElement>('.checklist-edit-row')].map(row => ({ id: row.dataset.id!, text: row.querySelector<HTMLInputElement>('[data-step-text]')!.value, done: row.querySelector<HTMLInputElement>('[data-step-done]')!.checked }));
    return { fields, steps };
  }
  dirty(form: HTMLFormElement) { const baseline = this.baselines.get(form); return !!baseline && baseline !== JSON.stringify(this.snapshot(form)); }
  capture(form: HTMLFormElement) {
    const record = this.contexts.get(form); if (!record || this.awaitingRestore.has(form)) return;
    if (!this.dirty(form)) { if (this.records.has(record.key)) this.remove(record.key); return; }
    this.put({ ...record, at: Date.now(), ...this.snapshot(form) });
  }
  saved(form: HTMLFormElement, submitted: string) {
    if (JSON.stringify(this.snapshot(form)) !== submitted) { this.capture(form); return; }
    const record = this.contexts.get(form); if (record) this.remove(record.key);
    this.baselines.set(form, submitted);
  }
  bind(form: HTMLFormElement, key: string, context: DraftContext, restoreSteps?: (steps: NonNullable<StudioDraft['steps']>) => void, repaint?: () => void) {
    this.contexts.set(form, { key, context });
    this.baselines.set(form, JSON.stringify(this.snapshot(form)));
    const draft = this.records.get(key);
    const restore = () => {
      if (!draft) return;
      this.awaitingRestore.delete(form);
      for (const field of draft.fields ?? []) {
        const inputs = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input[name],textarea[name],select[name]')].filter(el => el.name === field.name);
        const el = inputs.find(el => ['checkbox', 'radio'].includes(field.type) ? el.value === field.value : true);
        if (!el) continue;
        if (el instanceof HTMLInputElement && field.checked !== undefined) el.checked = field.checked; else el.value = field.value;
      }
      if (draft.steps) restoreSteps?.(draft.steps);
      repaint?.(); this.capture(form);
      const note = form.querySelector('.studio-form-note'); if (note) note.textContent = 'Restored your local draft. Review it, then save when ready.';
    };
    if (draft && draft.context.version === context.version) restore();
    else if (draft) {
      this.awaitingRestore.add(form);
      const note = form.querySelector('.studio-form-note');
      if (note) { note.textContent = 'This item changed since your draft. '; const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Restore draft to review'; button.addEventListener('click', restore); note.append(button); }
    }
    form.addEventListener('input', () => { this.awaitingRestore.delete(form); this.capture(form); });
    form.addEventListener('change', () => this.capture(form));
    // Add/remove step and portrait buttons change fields without firing native input events.
    form.addEventListener('click', () => queueMicrotask(() => { if (form.isConnected) this.capture(form); }));
  }
  discard(form: HTMLFormElement) { this.awaitingRestore.delete(form); this.baselines.set(form, JSON.stringify(this.snapshot(form))); const record = this.contexts.get(form); if (record) this.remove(record.key); }
}
