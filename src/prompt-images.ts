import { closeOnEscape } from './escape';

export interface ImagePreview { name: string; url?: string; status?: string }
export function renderPromptImages(root: HTMLElement, images: ImagePreview[]) {
  root.replaceChildren();
  root.classList.add('message-images');
  for (const [index, image] of images.entries()) {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'message-image';
    card.setAttribute('aria-label', `View attached image ${index + 1}: ${image.name}`);
    const name = document.createElement('span'); name.textContent = `Image ${index + 1}`; name.title = image.name;
    const status = document.createElement('small'); status.textContent = image.status || 'Attached';
    const unavailable = () => {
      card.querySelector('img')?.remove(); card.disabled = true;
      card.classList.add('preview-unavailable'); status.textContent = `${image.status || 'Attached'} · preview unavailable`;
    };
    if (image.url) {
      const img = document.createElement('img'); img.src = image.url; img.alt = image.name;
      img.loading = 'lazy'; img.onerror = unavailable; card.append(img);
      card.addEventListener('click', () => showImage(image, card));
    } else unavailable();
    card.append(name, status); root.append(card);
  }
}

function showImage(image: ImagePreview, trigger: HTMLElement) {
  const dialog = document.createElement('dialog'); dialog.className = 'attachment-viewer';
  dialog.setAttribute('aria-label', 'Attached image'); dialog.dataset.blockOfficeInput = '';
  const header = document.createElement('header'), title = document.createElement('b'); title.textContent = 'Attached image';
  const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.textContent = '×'; closeButton.setAttribute('aria-label', 'Close image preview');
  const img = document.createElement('img'); img.src = image.url!; img.alt = image.name;
  const close = () => { stopEscape(); dialog.close(); dialog.remove(); if (trigger.isConnected) trigger.focus({ preventScroll: true }); };
  const stopEscape = closeOnEscape(dialog, close);
  closeButton.onclick = close;
  dialog.oncancel = e => { e.preventDefault(); close(); };
  dialog.onclick = e => {
    if (e.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) close();
  };
  header.append(title, closeButton); dialog.append(header, img); document.body.append(dialog); dialog.showModal(); closeButton.focus();
}
