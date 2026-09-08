/** Attachment metadata only: image bytes never travel with conversation polling. */
export interface PromptImage { name: string; path?: string; key?: string; url?: string }
export interface ConversationTurn { prompt?: string; reply?: string; at?: number; images?: PromptImage[] }

export function promptWithImages(raw: string, inline: PromptImage[] = []) {
  const paths: string[] = [];
  const add = (path: string) => { if (path.startsWith('/') && !paths.includes(path)) paths.push(path); };
  let text = raw.replace(/<image\b[^>]*\bpath="([^"]+)"[^>]*>[\s\S]*?<\/image>/gi, (_tag, path) => { add(path); return ''; });
  text = text.replace(/\[Image:\s*source:\s*([^\]]+)\]/gi, (_tag, path) => { add(path.trim()); return ''; });
  const suffix = /(?:^|\n)Attached image files? \(available locally on this machine\):\s*\n((?:[ \t]*-[ \t]+[^\n]+(?:\n|$))+)/g;
  text = text.replace(suffix, (_section, list: string) => {
    for (const line of list.split('\n')) { const path = line.replace(/^\s*-\s*/, '').trim(); if (path) add(path); }
    return '\n';
  });
  const placeholders = [...text.matchAll(/\[Image(?:\s*#?\d+)?\]/gi)].length;
  text = text.replace(/\[Image(?:\s*#?\d+)?\]\s*/gi, '').trim();
  // Keep harness instructions out, while allowing real prompts prefixed with an image tag.
  if (/^\s*</.test(text) || /^\[Request interrupted/.test(text) || /^# AGENTS\.md instructions for /.test(text)) return { text: '', images: [] as PromptImage[] };
  const images: PromptImage[] = paths.slice(0, 16).map(path => ({ path, name: path.split('/').pop() || 'Image' }));
  // Inline blocks and placeholders usually describe those same files, not extra attachments.
  const count = Math.min(16, Math.max(images.length, inline.length, placeholders));
  for (let i = images.length; i < count; i++) images.push(inline[i] ?? { name: `Image ${i + 1}` });
  return { text, images };
}

export const imagePreviewUrl = (path: string) => `/api/image?path=${encodeURIComponent(path)}`;
