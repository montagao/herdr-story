import { expect, test } from 'bun:test';
import { ImageTray, type Attachment } from './attachments';
const attachment = (): Attachment => ({ file: new File(['image'], 'shot.png', { type: 'image/png' }), url: 'blob:preview' });
test('pre-upload and send share one request; successful paths survive message retries', async () => {
  const image = attachment(); let calls = 0;
  let finish!: (path: string) => void;
  const upload = () => { calls++; return new Promise<string>(resolve => { finish = resolve; }); };
  const preparing = ImageTray.prepare(image, upload);
  const sending = ImageTray.compose('Inspect this', [image], upload);
  expect(calls).toBe(1);
  finish('/tmp/image.png'); await preparing;
  expect(await sending).toContain('/tmp/image.png');
  expect(await ImageTray.compose('Retry', [image], upload)).toContain('/tmp/image.png');
  expect(calls).toBe(1);
});
test('failed eager upload retries and retains the image', async () => {
  const image = attachment(); let calls = 0;
  const upload = async () => { if (++calls === 1) throw Error('offline'); return '/tmp/retry.png'; };
  await expect(ImageTray.prepare(image, upload)).rejects.toThrow('offline');
  expect(image.uploadError).toContain('offline');
  expect(await ImageTray.compose('', [image], upload)).toContain('/tmp/retry.png');
  expect(calls).toBe(2); expect(image.file.name).toBe('shot.png');
});
