// Screenshot the dev page so an agent (or you) can look at the render. node scripts/shot.mjs [url] [out] [waitMs]
import { chromium } from 'playwright';
const [url = 'http://localhost:5173/', out = 'shots/latest.png', wait = '3000', click] = process.argv.slice(2); // click: "x,y"
const exe = process.env.PW_EXE || (await import('node:fs')).readdirSync(`${process.env.HOME}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium_headless_shell-')).sort().map((d) => `${process.env.HOME}/.cache/ms-playwright/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() !== 'log') console.log(`[console.${m.type()}]`, m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(Number(wait));
if (click) { const [x, y] = click.split(',').map(Number); await page.mouse.click(x, y); await page.waitForTimeout(1200); }
await page.screenshot({ path: out });
console.log('wrote', out);
await browser.close();
