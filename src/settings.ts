import { closeOnEscape } from './escape';

/** What a person can set about their office. Saved in this browser; the bridge never sees it. */
export interface OfficeSettings {
  /** Light the room by local time. Off, the clock is pinned to `hour`. */
  followDay: boolean;
  hour: number;
  furnitureByRank: boolean;
  nameTags: 'hover' | 'always';
  wander: boolean;
  sound: boolean;
  music: number;
  effects: number;
  notifications: boolean;
  recap: boolean;
  lowPower: boolean;
}
export const DEFAULT_SETTINGS: OfficeSettings = {
  followDay: true, hour: 12, furnitureByRank: true, nameTags: 'hover', wander: true,
  sound: true, music: 1, effects: 1, notifications: false, recap: true, lowPower: false,
};
const KEY = 'herdr-story:settings';
const unit = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;

/** A saved blob, or anything else, becomes a full and sane settings object. */
export function readSettings(raw: string | null | undefined, defaults = DEFAULT_SETTINGS): OfficeSettings {
  let saved: Record<string, unknown> = {};
  try { const parsed = raw ? JSON.parse(raw) : null; if (parsed && typeof parsed === 'object') saved = parsed; } catch { /* a bad save is no save */ }
  const bool = (key: keyof OfficeSettings) => typeof saved[key] === 'boolean' ? saved[key] as boolean : defaults[key] as boolean;
  const hour = typeof saved.hour === 'number' && Number.isFinite(saved.hour) ? Math.min(24, Math.max(0, saved.hour)) : defaults.hour;
  return {
    followDay: bool('followDay'), hour, furnitureByRank: bool('furnitureByRank'),
    nameTags: saved.nameTags === 'always' ? 'always' : saved.nameTags === 'hover' ? 'hover' : defaults.nameTags,
    wander: bool('wander'), sound: bool('sound'), music: unit(saved.music, defaults.music), effects: unit(saved.effects, defaults.effects),
    notifications: bool('notifications'), recap: bool('recap'), lowPower: bool('lowPower'),
  };
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;
export class Settings {
  value: OfficeSettings;
  /** Whether anything had been saved before: the first run seeds a few values from older keys. */
  readonly stored: boolean;
  private listeners = new Set<(value: OfficeSettings) => void>();
  constructor(private store?: Store) {
    let raw: string | null = null;
    try { raw = store?.getItem(KEY) ?? null; } catch { /* storage may be unavailable */ }
    this.stored = raw !== null;
    this.value = readSettings(raw);
  }
  set(patch: Partial<OfficeSettings>) {
    const next = readSettings(JSON.stringify({ ...this.value, ...patch }));
    if (JSON.stringify(next) === JSON.stringify(this.value)) return;
    this.value = next;
    try { this.store?.setItem(KEY, JSON.stringify(next)); } catch { /* the choice still lasts for the page */ }
    for (const listener of this.listeners) listener(next);
  }
  on(listener: (value: OfficeSettings) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
const browserStore = (): Store | undefined => { try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; } };
export const settings = new Settings(browserStore());

export function gearIcon(size = 16) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path d="M9.5 3h5l.5 2.3 1.5.9 2.2-.7 2.5 4.3-1.7 1.6v1.2l1.7 1.6-2.5 4.3-2.2-.7-1.5.9-.5 2.3h-5L9 18.7l-1.5-.9-2.2.7-2.5-4.3 1.7-1.6v-1.2L2.8 9.8l2.5-4.3 2.2.7L9 5.3Z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}
/** "7:30 PM", from a fractional hour. */
export function clockLabel(hour: number) {
  const h = Math.floor(hour) % 24, m = Math.round((hour - Math.floor(hour)) * 60);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export interface SettingsHooks {
  /** Opens the revenue settings; absent when there are no books to set. */
  revenue?: () => void;
  /** Asks the browser for notification permission; resolves to whether it was granted. */
  askNotifications?: () => Promise<boolean>;
}

/** The office's settings window, in the same furniture as the revenue and Stripe windows. */
export class SettingsDialog {
  private dialog?: HTMLDialogElement;
  private stopEscape?: () => void;
  constructor(private settings: Settings, private hooks: SettingsHooks = {}) {}

  open(returnTo?: HTMLElement | null) {
    if (this.dialog?.open) return;
    const dialog = this.dialog ??= document.createElement('dialog');
    dialog.className = 'office-settings setup-win';
    dialog.setAttribute('aria-labelledby', 'office-settings-title');
    // Not marked as blocking the office: the modal already takes the pointer, and the room going
    // on behind the window is the preview for every setting in it.
    const s = this.settings.value;
    const toggle = (name: keyof OfficeSettings, title: string, hint: string, on: boolean) =>
      `<label class="setting"><span><b>${title}</b><small>${hint}</small></span><input type="checkbox" class="pixel-switch" name="${name}"${on ? ' checked' : ''}></label>`;
    const range = (name: keyof OfficeSettings, title: string, hint: string, value: number, min: number, max: number, step: number, extra = '') =>
      `<label class="setting setting-range"${extra}><span><b>${title}</b><small data-hint-for="${name}">${hint}</small></span><input type="range" name="${name}" min="${min}" max="${max}" step="${step}" value="${value}"></label>`;
    dialog.innerHTML = `<div class="setup-head"><span class="setup-gear">${gearIcon(15)}</span><b id="office-settings-title">Office settings</b><button type="button" class="setup-x" aria-label="Close settings">×</button></div>
      <div class="setup-body office-settings-body">
        <section class="setting-group"><h3>The day</h3>
          ${toggle('followDay', 'Follow the day', 'Local time: dawn and dusk warm the room, night lights the desks.', s.followDay)}
          ${range('hour', 'Fixed light', clockLabel(s.hour), s.hour, 0, 24, 0.5, s.followDay ? ' hidden' : '')}
        </section>
        <section class="setting-group"><h3>The room</h3>
          ${toggle('furnitureByRank', 'Furniture follows rank', 'Better chairs and desks as agents level up.', s.furnitureByRank)}
          ${toggle('wander', 'Agents wander when idle', 'They stretch their legs and chat between tasks.', s.wander)}
          <label class="setting"><span><b>Name tags</b><small>Favourites and agents who need you are always named.</small></span><select name="nameTags"><option value="hover"${s.nameTags === 'hover' ? ' selected' : ''}>On hover</option><option value="always"${s.nameTags === 'always' ? ' selected' : ''}>Always</option></select></label>
        </section>
        <section class="setting-group"><h3>Sound</h3>
          ${toggle('sound', 'Sound', 'Music and effects. The mute button in the roster does the same.', s.sound)}
          ${range('music', 'Music', `${Math.round(s.music * 100)}%`, s.music, 0, 1, 0.05)}
          ${range('effects', 'Effects', `${Math.round(s.effects * 100)}%`, s.effects, 0, 1, 0.05)}
        </section>
        <section class="setting-group"><h3>Alerts</h3>
          ${toggle('notifications', 'Browser notifications', 'A notification when an agent needs you, even in another tab.', s.notifications)}
          ${toggle('recap', '“While you were away”', 'The recap card when you come back to the office.', s.recap)}
        </section>
        <section class="setting-group"><h3>Performance</h3>
          ${toggle('lowPower', 'Low power', 'Halves the frame rate. Kind to laptops and phones.', s.lowPower)}
        </section>
        ${this.hooks.revenue ? `<section class="setting-group"><h3>Money</h3><button type="button" class="setting-button" data-revenue>Revenue settings…</button><p class="setup-hint">Reporting period and payment sources.</p></section>` : ''}
        <p class="setup-hint">Saved in this browser.</p>
      </div>`;
    const close = () => { dialog.close(); dialog.hidden = true; this.stopEscape?.(); returnTo?.focus({ preventScroll: true }); };
    dialog.querySelector('.setup-x')!.addEventListener('click', close);
    this.stopEscape = closeOnEscape(dialog, close);
    dialog.oncancel = event => { event.preventDefault(); close(); };
    dialog.onclick = event => { if (event.target === dialog) {
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
    } };
    dialog.querySelector('[data-revenue]')?.addEventListener('click', () => { close(); this.hooks.revenue?.(); });
    const hint = (name: string) => dialog.querySelector<HTMLElement>(`[data-hint-for="${name}"]`);
    dialog.addEventListener('input', event => {
      const input = event.target as HTMLInputElement | HTMLSelectElement;
      if (!input.name) return;
      if (input.name === 'hour') hint('hour')!.textContent = clockLabel(Number(input.value));
      if (input.name === 'music' || input.name === 'effects') hint(input.name)!.textContent = `${Math.round(Number(input.value) * 100)}%`;
      if (input.type === 'range') this.settings.set({ [input.name]: Number(input.value) });
    });
    dialog.addEventListener('change', async event => {
      const input = event.target as HTMLInputElement | HTMLSelectElement;
      if (!input.name) return;
      if (input.name === 'nameTags') { this.settings.set({ nameTags: input.value === 'always' ? 'always' : 'hover' }); return; }
      if (input.type !== 'checkbox') return;
      const box = input as HTMLInputElement;
      if (box.name === 'notifications' && box.checked) {
        const granted = await (this.hooks.askNotifications?.() ?? Promise.resolve(false));
        if (!granted) { box.checked = false; return; }
      }
      this.settings.set({ [box.name]: box.checked });
      if (box.name === 'followDay') dialog.querySelector<HTMLElement>('[data-hint-for="hour"]')!.closest<HTMLElement>('.setting')!.hidden = box.checked;
    });
    document.body.append(dialog);
    dialog.hidden = false; dialog.showModal();
    dialog.querySelector<HTMLElement>('.setup-x')?.blur();
    dialog.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
  }
}
