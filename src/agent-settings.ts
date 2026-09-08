import { supportsAgentSettings, type AgentSettingsOptions } from '../shared/agent-settings';
import type { OfficeClient } from './net/office-client';

let nextId = 0;
export function settingsFields(live = false) {
  const id = `agent-models-${++nextId}`;
  return `<div class="agent-settings-fields">
    <label class="hire-field"><span>Model</span><input name="model" list="${id}" maxlength="160" autocomplete="off" placeholder="Agent default"><datalist id="${id}"></datalist>${live ? '<button type="button" data-apply-setting="model">Apply model</button>' : ''}</label>
    <label class="hire-field"><span>Reasoning effort</span><select name="effort"><option value="">${live ? 'Choose effort' : 'Agent default'}</option></select>${live ? '<button type="button" data-apply-setting="effort">Apply effort</button>' : ''}</label>
    <small class="agent-settings-note" aria-live="polite">Loading model choices…</small>
  </div>`;
}

export function bindSettings(host: HTMLElement, client: OfficeClient, live = false) {
  const model = host.querySelector<HTMLInputElement>('[name="model"]')!;
  const effort = host.querySelector<HTMLSelectElement>('[name="effort"]')!;
  const list = host.querySelector('datalist')!;
  const note = host.querySelector<HTMLElement>('.agent-settings-note')!;
  let options: AgentSettingsOptions = { models: [], efforts: [] }, generation = 0;
  const updateEfforts = () => {
    const previous = effort.value;
    const levels = options.models.find(m => m.id === model.value.trim())?.efforts ?? options.efforts;
    effort.replaceChildren(new Option(live ? 'Choose effort' : 'Agent default', ''), ...levels.map(e => new Option(e, e)));
    if (levels.includes(previous)) effort.value = previous;
  };
  model.addEventListener('input', updateEfforts);
  return async (kind: string, currentModel?: string | null) => {
    const version = ++generation, supported = supportsAgentSettings(kind);
    host.hidden = !supported;
    model.disabled = effort.disabled = !supported;
    model.value = ''; effort.value = ''; list.replaceChildren();
    options = { models: [], efforts: [] }; updateEfforts();
    model.placeholder = live ? currentModel || 'Model ID' : 'Agent default';
    if (!supported) return;
    note.textContent = 'Loading model choices…';
    try {
      const loaded = await client.call('agent.settings.options', { kind }) as AgentSettingsOptions;
      if (version !== generation) return;
      options = loaded;
      list.replaceChildren(...options.models.map(m => new Option(m.label, m.id)));
      updateEfforts();
      note.textContent = live
        ? kind === 'codex' ? 'Changes apply to subsequent turns.' : 'Apply one choice at a time while Claude is idle; check its terminal for confirmation. Claude may save this as its default.'
        : 'Choose a suggested model or enter its ID. Leave blank to use agent defaults. Availability depends on your account.';
    } catch {
      if (version === generation) note.textContent = 'Model choices unavailable. You can still enter a model ID.';
    }
  };
}
