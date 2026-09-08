import type { OfficeClient } from './net/office-client';

/** An asset check uses an actual image so SPA HTML fallbacks cannot masquerade as a PNG. */
export function hasOfficeArt(): Promise<boolean> {
  return new Promise(resolve => {
    const image = new Image();
    const timeout = setTimeout(() => resolve(false), 4000);
    image.onload = () => { clearTimeout(timeout); resolve(image.naturalWidth > 0); };
    image.onerror = () => { clearTimeout(timeout); resolve(false); };
    image.src = '/assets/gds/body/body0.png';
  });
}

export function openRosterOnly(client: OfficeClient, demo: boolean) {
  document.body.classList.add('roster-only');
  document.getElementById('loading')?.remove();
  for (const id of ['game', 'hire-agent', 'settings', 'mute']) document.getElementById(id)?.remove();
  const header = document.createElement('section');
  header.className = 'roster-welcome';
  header.innerHTML = `<h1>Herdr Story</h1><p>Roster &amp; conversations</p>
    <p>The pixel-art office needs a separate local art pack. You can still open an agent below
    to read its conversation${demo ? '' : ', send a prompt, or stop its task'}.</p>
    <a href="https://github.com/montagao/herdr-story/blob/main/docs/assets.md" target="_blank" rel="noopener noreferrer">About the office artwork ↗</a>
    <a href="${demo ? '/' : '?demo=1&roster=1'}">${demo ? 'Return to live agents' : 'Explore the fictional demo'}</a>
    <p class="roster-connection" role="status"></p>`;
  document.getElementById('feed')!.prepend(header);
  const status = header.querySelector<HTMLElement>('.roster-connection')!;
  let connectedOnce = client.connected;
  const update = () => { status.textContent = demo ? 'Fictional demo · read-only · no live agents or payments'
    : client.connected ? 'Connected to your local bridge' : connectedOnce
      ? 'Reconnecting to the bridge… Check that npm run dev is running.' : 'Connecting to the bridge…';
    connectedOnce ||= client.connected;
  };
  update(); client.on(update); setInterval(update, 1500);
  (window as any).__herdrReady = true;
}
