// Images attached to a prompt: pasted or dropped into a form, previewed in a tray, uploaded to the
// bridge on send, and named in the prompt by the local path the bridge hands back. Shared by the
// conversation window's reply box and the recruitment desk's first task.
export type Attachment = { file: File; url: string; path?: string; uploading?: Promise<string>; uploadError?: string };
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_ATTACHMENTS = 4;

/** The paragraph appended to a prompt so the agent can open what was attached. */
export function imageSuffix(paths: string[]) {
  return `Attached image file${paths.length === 1 ? '' : 's'} (available locally on this machine):\n${paths.map((path) => `- ${path}`).join('\n')}`;
}
/** Image files carried by a paste or a drop, in order. */
export function imageFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const files = Array.from(data.items ?? []).filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => !!file);
  return files.length ? files : Array.from(data.files ?? []).filter((file) => file.type.startsWith('image/'));
}

export class ImageTray {
  attachments: Attachment[] = [];
  /** @param urls preview object URLs, owned by the window so it can revoke them when it closes */
  constructor(private tray: HTMLElement, private note: (text: string, state?: string) => void, private urls: Set<string>, private onChange?: () => void, private upload?: (file: File) => Promise<string>) {}
  get length() { return this.attachments.length; }
  add(files: File[]) {
    for (const file of files) {
      if (this.attachments.length >= MAX_ATTACHMENTS) { this.note(`up to ${MAX_ATTACHMENTS} images can be attached`, 'error'); break; }
      if (!IMAGE_TYPES.includes(file.type)) { this.note('paste a PNG, JPEG, WebP, or GIF image', 'error'); continue; }
      if (file.size > 12 * 1024 * 1024) { this.note('image is too large (12 MB limit)', 'error'); continue; }
      const url = URL.createObjectURL(file); this.urls.add(url);
      const attachment: Attachment = { file, url }; this.attachments.push(attachment);
      if (this.upload) void ImageTray.prepare(attachment, this.upload).then(() => {
        if (!this.attachments.includes(attachment)) return;
        this.render(); this.reportUploads();
      }, () => { if (this.attachments.includes(attachment)) { this.render(); this.reportUploads(); } });
    }
    this.render();
    if (this.attachments.length) this.note(this.attachments.some(a => a.uploading)
      ? `Uploading ${this.attachments.length} image${this.attachments.length === 1 ? '' : 's'}…`
      : `${this.attachments.length} image${this.attachments.length === 1 ? '' : 's'} attached`);
  }
  private reportUploads() {
    if (this.attachments.some(a => a.uploading)) this.note('Uploading images…', 'sending');
    else if (this.attachments.some(a => a.uploadError)) this.note('Image upload failed · sending will retry', 'error');
    else this.note(`${this.attachments.length === 1 ? 'Image uploaded' : 'Images uploaded'} · ready to send`);
  }
  /** Hand the attachments over for sending, leaving the tray empty. */
  take() { const list = this.attachments; this.attachments = []; this.render(); return list; }
  /** Put attachments back after a send that did not go through. */
  restore(list: Attachment[]) { this.attachments = [...list, ...this.attachments]; this.render(); }
  render() {
    this.tray.replaceChildren(); this.tray.hidden = this.attachments.length === 0;
    for (const attachment of this.attachments) {
      const item = document.createElement('span'); item.className = 'reply-attachment';
      const img = document.createElement('img'); img.src = attachment.url; img.alt = 'Attached image preview';
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-image'; remove.title = 'Remove image'; remove.setAttribute('aria-label', 'Remove attached image'); remove.textContent = '×';
      remove.addEventListener('click', () => {
        this.attachments = this.attachments.filter((candidate) => candidate !== attachment);
        URL.revokeObjectURL(attachment.url); this.urls.delete(attachment.url); this.render(); this.onChange?.();
      });
      const status = document.createElement('small'); status.className = 'attachment-status';
      status.textContent = attachment.path ? 'uploaded' : attachment.uploading ? 'uploading…' : attachment.uploadError ? 'retry on send' : 'attached';
      status.setAttribute('role', 'status');
      item.append(img, remove, status); this.tray.append(item);
    }
  }
  /** Paste into the input, or drop anywhere on the zone. */
  listen(input: HTMLElement, zone: HTMLElement) {
    input.addEventListener('paste', (e) => {
      const files = imageFiles(e.clipboardData);
      if (!files.length) return;
      e.preventDefault(); this.add(files);
    });
    let depth = 0;
    zone.addEventListener('dragenter', (e) => { if (!imageDrag(e)) return; e.preventDefault(); depth++; zone.classList.add('drop-target'); });
    zone.addEventListener('dragover', (e) => { if (!imageDrag(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
    zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('drop-target'); } });
    zone.addEventListener('drop', (e) => {
      depth = 0; zone.classList.remove('drop-target');
      const files = imageFiles(e.dataTransfer);
      if (!files.length) return;
      e.preventDefault(); this.add(files);
      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) input.focus();
    });
  }
  /** Start once, share an in-flight upload, and retain successful paths for retries. */
  static prepare(attachment: Attachment, upload: (file: File) => Promise<string>): Promise<string> {
    if (attachment.path) return Promise.resolve(attachment.path);
    if (attachment.uploading) return attachment.uploading;
    attachment.uploadError = undefined;
    attachment.uploading = upload(attachment.file).then(path => {
      attachment.path = path; attachment.uploading = undefined; return path;
    }, error => { attachment.uploading = undefined; attachment.uploadError = String(error); throw error; });
    return attachment.uploading;
  }
  /** Upload every attachment and fold the paths into the prompt text. */
  static async compose(text: string, images: Attachment[], upload: (file: File) => Promise<string>, limit = 20_000) {
    if (!images.length) return text;
    const paths = await Promise.all(images.map((attachment) => ImageTray.prepare(attachment, upload)));
    const body = text.trim() || `Please inspect the attached image${paths.length === 1 ? '' : 's'}.`;
    const suffix = imageSuffix(paths);
    if (body.length + suffix.length + 2 > limit) throw new Error('message is too long once image paths are included');
    return `${body}\n\n${suffix}`;
  }
}
/** A drag that carries files (a text selection dragged across the form is not one). */
function imageDrag(e: DragEvent) { return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files'); }
