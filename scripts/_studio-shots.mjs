// Screenshot every studio tab. node studio-shots.mjs <outdir> [url]
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
const [out = '.', url = 'http://localhost:5173/'] = process.argv.slice(2);
const cache = `${process.env.HOME}/.cache/ms-playwright`;
const exe = process.env.PW_EXE || readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().map(d => `${cache}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath: exe });
for (const [w, h, tag] of [[1400, 900, 'desktop'], [390, 844, 'mobile']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.hs?.studio?.state, null, { timeout: 15000 }).catch(() => console.log('no studio state'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${tag}-office.png` });
  for (const tab of ['boards', 'people', 'journal', 'trophies', 'room']) {
    await page.evaluate(t => window.hs.studio.open(t), tab);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/${tag}-${tab}.png` });
  }
  await page.evaluate(() => { window.hs.studio.open('boards'); document.querySelector('[data-add-goal]')?.click(); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${tag}-goal-editor.png` });
  await page.close();
}
await browser.close();
console.log('done');
