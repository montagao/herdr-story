import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promptWithImages } from '../shared/prompt-images';
import { parseTranscript, readTranscript } from './transcript';
import { allowedAttachmentPath, attachmentImage, publicPromptImage } from './attachment-images';

const j = JSON.stringify;
const user = (text: string, blocks: unknown[] = []) => j({ type: 'response_item', payload: {
  type: 'message', role: 'user', content: [{ type: 'input_text', text }, ...blocks],
} });
const path = '/tmp/herdr-story-images/example.png';
const suffix = `Attached image file (available locally on this machine):\n- ${path}`;

test('local, clipboard, and inline representations retain one image and clean prompt text', () => {
  const parsed = promptWithImages(`<image name=[Image #1] path="${path}">[Image #1]</image>\n[Image #1] fix this\n\n${suffix}`, [{ name: 'Image 1', key: 'inline' }]);
  expect(parsed).toEqual({ text: 'fix this', images: [{ name: 'example.png', path }] });
  expect(promptWithImages(`[Image: source: ${path}]\nfix this`)).toEqual(parsed);
  expect(promptWithImages('<environment_context>instructions</environment_context>', [{ name: 'Image 1' }])).toEqual({ text: '', images: [] });
  expect(promptWithImages(`fix both\nAttached image files (available locally on this machine):\n- ${path}\n- /tmp/herdr-clipboard-images-1000/second.jpg`).images).toHaveLength(2);
});

test('same words with different images create separate turns; image-only turns retain replies', () => {
  const parsed = parseTranscript([
    user(`fix it\n${suffix}`), user(`fix it\n${suffix.replace('example', 'second')}`),
    user(suffix), j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Inspected the image.' }] } }),
  ]);
  expect(parsed.turns).toHaveLength(3);
  expect(parsed.turns[0].images?.[0].path).toBe(path);
  expect(parsed.turns[1].images?.[0].path).toContain('second.png');
  expect(parsed.turns[2]).toMatchObject({ prompt: 'Image attached', reply: 'Inspected the image.', images: [{ path }] });
});

test('native Claude and Codex inline images keep small metadata, without polling image bytes', () => {
  const bytes = 'data:image/png;base64,' + 'a'.repeat(100_000);
  const codex = parseTranscript([user('inspect', [{ type: 'input_image', image_url: bytes }])]);
  const claude = parseTranscript([j({ type: 'user', message: { content: [{ type: 'text', text: 'inspect' }, { type: 'image', source: { data: bytes } }] } })]);
  expect(codex.turns[0].images).toEqual(claude.turns[0].images);
  expect(j(codex).length).toBeLessThan(400);
  expect(codex.turns[0].images?.[0].key).toHaveLength(64);
  expect(parseTranscript([user('inspect', [{ type: 'input_image', image_url: 'different' }])], codex).turns).toHaveLength(2);
});

test('attachments survive backwards transcript reads and incremental replies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-image-transcript-'));
  try {
    const file = join(dir, 'session.jsonl');
    const lines = user(suffix) + '\n' + j({ type: 'event_msg', padding: 'x'.repeat(4000) }) + '\n';
    await Bun.write(file, lines);
    expect((await readTranscript(file, 100)).turns[0].images?.[0].path).toBe(path);
    await Bun.write(file, lines + j({ type: 'assistant', message: { content: 'Looks good.' } }) + '\n');
    expect((await readTranscript(file, 100)).turns).toMatchObject([{ prompt: 'Image attached', reply: 'Looks good.', images: [{ path }] }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preview metadata exposes only approved local attachment locations', () => {
  expect(allowedAttachmentPath(path)).toBe(true);
  expect(allowedAttachmentPath('/tmp/herdr-clipboard-images-1000/client-62.png')).toBe(true);
  for (const unsafe of ['/etc/passwd', '/tmp/secret.png', '/tmp/herdr-story-images/../secret.png', '/tmp/herdr-story-images/sub/image.png', '/tmp/herdr-story-images/text.svg', 'https://example.com/img.png']) {
    expect(allowedAttachmentPath(unsafe)).toBe(false);
    expect(publicPromptImage({ name: 'Image 1', path: unsafe })).toEqual({ name: 'Image 1' });
  }
  expect(publicPromptImage({ name: 'example.png', path }).url).toBe('/api/image?path=' + encodeURIComponent(path));
});

test('preview endpoint serves real uploads, blocks nonimages and symlink escapes', async () => {
  const dir = join(tmpdir(), 'herdr-story-images'); mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID(), image = join(dir, `${id}.png`), bad = join(dir, `${id}-bad.png`), link = join(dir, `${id}-link.png`);
  const outside = mkdtempSync(join(tmpdir(), 'herdr-outside-preview-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOc8AAAAASUVORK5CYII=', 'base64');
  try {
    await Bun.write(image, png); await Bun.write(bad, '<html>Not an image</html>');
    await Bun.write(join(outside, 'image.png'), png); symlinkSync(join(outside, 'image.png'), link);
    const response = await attachmentImage(image);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toContain('private');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(png));
    for (const missing of [bad, link, '/etc/passwd', join(dir, `${id}-missing.png`)]) expect((await attachmentImage(missing)).status).toBe(404);
  } finally {
    for (const file of [image, bad, link]) rmSync(file, { force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
