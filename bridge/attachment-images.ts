import { realpath, stat } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { imagePreviewUrl, type PromptImage } from '../shared/prompt-images';

/** Only image files created by the office or Herdr's clipboard integration may be previewed. */
export function allowedAttachmentPath(path: string, temporary = tmpdir()) {
  if (!path || path.includes('\0') || resolve(path) !== path) return false;
  const directory = dirname(path);
  return (directory === join(temporary, 'herdr-story-images')
    || (dirname(directory) === temporary && /^herdr-clipboard-images-\d+$/.test(basename(directory))))
    && /^[\w.-]+\.(png|jpe?g|webp|gif)$/i.test(basename(path));
}
export function publicPromptImage(image: PromptImage): PromptImage {
  const { name, key, path } = image;
  return { name, ...(key ? { key } : {}), ...(path && allowedAttachmentPath(path) ? { path, url: imagePreviewUrl(path) } : {}) };
}

export async function attachmentImage(path: string): Promise<Response> {
  const missing = () => new Response('Image preview unavailable', { status: 404 });
  if (!allowedAttachmentPath(path)) return missing();
  try {
    // A symlink must not turn this into an arbitrary file endpoint, including through a directory.
    const actual = await realpath(path), temporary = await realpath(tmpdir());
    if (!allowedAttachmentPath(actual, temporary)) return missing();
    const info = await stat(actual);
    if (!info.isFile() || info.size > 12 * 1024 * 1024) return missing();
    const file = Bun.file(actual), head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const ascii = (start: number, end: number) => String.fromCharCode(...head.slice(start, end));
    const mime = head[0] === 0x89 && ascii(1, 4) === 'PNG' ? 'image/png'
      : head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? 'image/jpeg'
      : /^GIF8[79]a$/.test(ascii(0, 6)) ? 'image/gif'
      : ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' ? 'image/webp' : null;
    if (!mime) return missing();
    return new Response(file, { headers: { 'content-type': mime, 'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=3600', 'content-security-policy': "default-src 'none'" } });
  } catch { return missing(); }
}
