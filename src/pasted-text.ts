import { imageFiles } from './attachments';

export const isLongText = (text: string) => text.length > 600 || text.split('\n').length > 8;
const label = (text: string) => `Pasted text · ${text.split('\n').length.toLocaleString()} lines · ${text.length.toLocaleString()} characters`;

/** A display-only fold: the request and queue receipt always retain the complete original text. */
export function renderPromptText(host: HTMLElement, text: string) {
  host.replaceChildren();
  if (!isLongText(text)) { host.textContent = text; return; }
  const details = document.createElement('details'); details.className = 'pasted-text';
  const summary = document.createElement('summary'); summary.textContent = label(text);
  const pre = document.createElement('pre'); pre.className = 'prompt-full-text'; pre.textContent = text;
  pre.tabIndex = 0; pre.setAttribute('aria-label', 'Full message text');
  details.append(summary, pre); host.append(details);
}

/** Fold long pastes without replacing the textarea's value with a lossy placeholder. */
export class PastedDraft {
  private details = document.createElement('details');
  private summary = document.createElement('summary');
  constructor(private input: HTMLTextAreaElement, private note: (message: string, state?: string) => void) {
    this.details.className = 'pasted-draft'; this.details.open = true; this.summary.hidden = true;
    this.details.append(this.summary);
    input.addEventListener('input', () => this.refresh());
    input.addEventListener('paste', event => {
      if (event.defaultPrevented || input.disabled || input.readOnly || imageFiles(event.clipboardData).length) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!isLongText(text)) return;
      event.preventDefault();
      const size = input.value.length - (input.selectionEnd - input.selectionStart) + text.length;
      if (input.maxLength >= 0 && size > input.maxLength) {
        this.note(`Message is too long (${input.maxLength.toLocaleString()} character limit). Nothing was pasted.`, 'error'); return;
      }
      input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      this.refresh(true); this.summary.focus();
      this.note('Pasted text ready to send · expand to review or edit');
    });
    this.refresh();
  }
  refresh(collapse = false) {
    const focused = document.activeElement === this.input;
    const long = isLongText(this.input.value);
    this.details.classList.toggle('is-long', long); this.summary.hidden = !long;
    this.summary.textContent = long ? label(this.input.value) : '';
    if (long && !this.details.isConnected) { this.input.before(this.details); this.details.append(this.input); }
    if (!long) {
      if (this.details.isConnected) { this.details.before(this.input); this.details.remove(); }
      this.details.open = true;
    }
    else if (collapse) this.details.open = false;
    if (focused && this.details.open) this.input.focus();
  }
  focus() { (this.details.open ? this.input : this.summary).focus(); }
}
