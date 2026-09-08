import type { Saved, SavedPatch } from './storage';

const rows = new Set(['employees', 'projects', 'journal']);
const maps = new Set(['identities', 'observations']);
type Scope = { table: string; id?: string };
/** A short-lived synchronous draft. Only writes are recorded: unchanged history is neither
 * cloned for rollback nor copied into the worker message. Restore before awaiting I/O, then
 * replay after SQLite acknowledges the commit, so readers always see committed data. */
export class StorageMutation<T extends Saved> {
  readonly draft: T;
  private proxies = new WeakMap<object, object>();
  private raw = new WeakMap<object, object>();
  private undo: (() => void)[] = [];
  private redo: (() => void)[] = [];
  private touched = new Map<string, Set<string>>();
  private meta = new Set<string>();
  private beforeRows = new Map<string, Map<string, any>>();
  private restored = false;
  constructor(readonly state: T) { this.draft = this.wrap(state) as T; }
  /** A fresh object written into the state may carry draft proxies anywhere inside it — a
   *  re-saved journal entry keeps the old row's contributors, a filtered array holds row
   *  proxies — and a proxy left in committed state cannot be cloned for the worker. */
  private unwrap(value: any, seen = new Set<object>()): any {
    if (!value || typeof value !== 'object') return value;
    const original = this.raw.get(value); if (original) return original;
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => this.unwrap(item, seen));
    for (const key of Object.keys(value)) {
      const item = value[key], plain = this.unwrap(item, seen);
      if (plain !== item) value[key] = plain;
    }
    return value;
  }
  private touch(scope: Scope) {
    if (scope.id === undefined) { this.meta.add(scope.table); return; }
    let ids = this.touched.get(scope.table);
    if (!ids) this.touched.set(scope.table, ids = new Set());
    if (ids.has(scope.id)) return;
    ids.add(scope.id);
    if (rows.has(scope.table)) {
      let before = this.beforeRows.get(scope.table);
      if (!before) this.beforeRows.set(scope.table, before = new Map());
      const row = (this.state as any)[scope.table].find((row: any) => row.id === scope.id);
      before.set(scope.id, row ? structuredClone(row) : undefined);
    }
  }
  private wrap(value: any, scope?: Scope): any {
    if (!value || typeof value !== 'object') return value;
    const cached = this.proxies.get(value); if (cached) return cached;
    const collection = scope && rows.has(scope.table) && scope.id === undefined;
    const proxy = new Proxy(value, {
      get: (target, key) => {
        // Looking up one row should not allocate a proxy for every preceding history entry.
        if (collection && ['find', 'findIndex', 'some', 'filter', 'map'].includes(String(key))) return (...args: any[]) => {
          const result = target[key](...args);
          return key === 'find' && result ? this.wrap(result, { table: scope.table, id: result.id }) : result;
        };
        if (collection && key === 'indexOf') return (item: any, from?: number) => target.indexOf(this.unwrap(item), from);
        const item = Reflect.get(target, key);
        const next = target === this.state ? { table: String(key) }
          : collection && item && typeof item === 'object' && 'id' in item ? { table: scope.table, id: item.id }
          : scope && maps.has(scope.table) && scope.id === undefined ? { table: scope.table, id: String(key) } : scope;
        return this.wrap(item, next);
      },
      set: (target, key, input) => {
        const next = this.unwrap(input), previous = Reflect.getOwnPropertyDescriptor(target, key);
        if (previous?.value === next) return true;
        if (target === this.state && rows.has(String(key))) {
          const before = new Map<string, object>(target[key].map((row: any) => [row.id, row]));
          const after = new Map<string, object>(next.map((row: any) => [row.id, this.unwrap(row)]));
          for (const [id, row] of before) if (after.get(id) !== row) this.touch({ table: String(key), id });
          for (const [id, row] of after) if (before.get(id) !== row) this.touch({ table: String(key), id });
        } else if (collection) {
          if (previous?.value?.id) this.touch({ table: scope.table, id: previous.value.id });
          if (next?.id) this.touch({ table: scope.table, id: next.id });
        } else if (target === this.state) this.touch({ table: String(key) });
        else if (scope && maps.has(scope.table) && scope.id === undefined) this.touch({ table: scope.table, id: String(key) });
        else if (scope) this.touch(scope);
        const length = Array.isArray(target) ? target.length : undefined;
        Reflect.set(target, key, next);
        this.undo.push(() => {
          if (previous) Reflect.defineProperty(target, key, previous); else Reflect.deleteProperty(target, key);
          if (length !== undefined) target.length = length;
        });
        this.redo.push(() => { Reflect.set(target, key, next); });
        return true;
      },
      deleteProperty: (target, key) => {
        const previous = Reflect.getOwnPropertyDescriptor(target, key); if (!previous) return true;
        if (collection && previous.value?.id) this.touch({ table: scope.table, id: previous.value.id });
        else if (scope && maps.has(scope.table) && scope.id === undefined) this.touch({ table: scope.table, id: String(key) });
        else if (scope) this.touch(scope);
        Reflect.deleteProperty(target, key);
        this.undo.push(() => { Reflect.defineProperty(target, key, previous); });
        this.redo.push(() => { Reflect.deleteProperty(target, key); });
        return true;
      },
    });
    this.proxies.set(value, proxy); this.raw.set(proxy, value); return proxy;
  }
  patch(): SavedPatch {
    const patch: SavedPatch = { rows: {}, maps: {}, meta: {} };
    for (const [table, ids] of this.touched) {
      if (rows.has(table)) {
        const current = new Map<string, any>((this.state as any)[table].map((row: any) => [row.id, row]));
        const upsert: any[] = [], remove: string[] = [];
        for (const id of ids) {
          const row = current.get(id), before = this.beforeRows.get(table)?.get(id);
          if (!row) { if (before) remove.push(id); }
          else if (!before || JSON.stringify(before) !== JSON.stringify(row)) upsert.push(structuredClone(row));
        }
        if (upsert.length || remove.length) patch.rows[table as keyof SavedPatch['rows']] = { upsert, remove };
      } else {
        const upsert: Record<string, unknown> = {}, remove: string[] = [];
        for (const key of ids) {
          if (Object.hasOwn((this.state as any)[table], key)) upsert[key] = structuredClone((this.state as any)[table][key]); else remove.push(key);
        }
        patch.maps[table as keyof SavedPatch['maps']] = { upsert, remove };
      }
    }
    for (const key of this.meta) patch.meta[key] = structuredClone((this.state as any)[key]);
    return patch;
  }
  /** Previous versions of changed rows, for incremental history summaries/invalidation. */
  previousRows(table: string) { return this.beforeRows.get(table) ?? new Map<string, any>(); }
  restore() { if (!this.restored) { for (let n = this.undo.length - 1; n >= 0; n--) this.undo[n](); this.restored = true; } }
  publish() { if (this.restored) { for (const apply of this.redo) apply(); this.restored = false; } }
}
