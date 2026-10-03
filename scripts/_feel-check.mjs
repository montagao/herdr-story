// An isolated office for look-and-feel checks: how windows land, what animates, what sound plays.
//
//   node scripts/_feel-check.mjs <scenario.mjs> [--out <dir>] [--dist] [--static] [--viewport 1280x800] [--reduced-motion] [--touch] [--keep-going]
//
// What it starts, all private to this run and torn down afterwards:
//   * a MOCK bridge on a free port with a throwaway state dir (payment keys blanked, so nothing
//     ever reaches Stripe/RevenueCat and nothing touches the real bridge on :7788)
//   * by default a private Vite dev server (own port, own cache dir, no HMR/file watching) that
//     proxies /ws and /api to that mock bridge — so it serves the CURRENT source tree without
//     writing dist/. With --dist it instead loads the production bundle the mock bridge serves
//     from dist/ (run `npm run build` first; only one process should build at a time).
//   * headless Chromium (Playwright's cached headless shell)
//
// --static   freezes the mock agents (no random status changes) for stable screenshots
//
// The scenario file default-exports `async (t) => { ... }`. See the `t` object below. For example:
//
//   export default async (t) => {
//     await t.open('debug&hour=12'); await t.closeTray(); await t.unlockAudio();
//     const moved = await t.scrub('front-desk', () => t.page.locator('#front-desk').click(), { node: true });
//     t.log(moved.map((a) => `${a.target} ${a.name} ${a.duration}ms`));   // [] would mean it popped with no motion
//     t.log((await t.audio()).filter((a) => a.kind === 'sample').map((a) => a.src));
//   };
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer as netServer } from 'node:net';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--out', '--viewport'].includes(argv[i - 1]));
const scenarioPath = positional[0];
if (!scenarioPath) { console.error('usage: node scripts/_feel-check.mjs <scenario.mjs> [--out dir] [--dist] [--static] [--viewport WxH] [--reduced-motion]'); process.exit(2); }
const out = resolve(opt('--out', join(tmpdir(), 'herdr-feel', String(process.pid))));
mkdirSync(out, { recursive: true });
const [vw, vh] = opt('--viewport', '1280x800').split('x').map(Number);
const useDist = flag('--dist');

const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bridgePort = await freePort();
const vitePort = useDist ? 0 : await freePort();
const stateDir = mkdtempSync(join(tmpdir(), 'hs-feel-'));
const cleanup = [];
let exitCode = 0;

// ---- mock bridge ---------------------------------------------------------------------------
const bridgeEnv = { ...process.env,
  HERDR_STORY_PORT: String(bridgePort), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: stateDir,
  HERDR_STORY_ALLOWED_ORIGINS: useDist ? '' : `http://127.0.0.1:${vitePort}`,
  // Bun auto-loads the project's .env; an explicit empty value wins over it, so no real keys load.
  STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '',
  REVENUECAT_PROJECT_ID: '', HERDR_STORY_WEBHOOK_PORT: '', REVENUECAT_WEBHOOK_AUTH: '', REVENUECAT_WEBHOOK_PUBLIC_URL: '',
  REVENUECAT_WEBHOOK_INTEGRATION_ID: '', REVENUECAT_WEBHOOK_SIGNING_SECRET: '',
  ...(flag('--static') ? { HERDR_STORY_MOCK_STATIC: '1' } : {}),
};
const bridge = spawn('bun', ['bridge/server.ts', '--mock'], { cwd: ROOT, env: bridgeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let bridgeLog = '';
bridge.stdout.on('data', (d) => { bridgeLog += d; }); bridge.stderr.on('data', (d) => { bridgeLog += d; });
cleanup.push(() => { try { bridge.kill(); } catch {} });
let up = false;
for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${bridgePort}/health`)).ok; } catch {} if (!up) await sleep(250); }
if (!up) { console.error('[feel] mock bridge did not start:\n' + bridgeLog); bridge.kill(); process.exit(1); }

// ---- page server ---------------------------------------------------------------------------
let base = `http://127.0.0.1:${bridgePort}`;
if (!useDist) {
  const vite = await import(pathToFileURL(join(ROOT, 'node_modules/vite/dist/node/index.js')).href);
  const cacheDir = mkdtempSync(join(tmpdir(), 'hs-feel-vite-'));
  const server = await vite.createServer({
    root: ROOT, configFile: join(ROOT, 'vite.config.ts'), cacheDir, logLevel: 'error', clearScreen: false,
    server: { port: vitePort, strictPort: true, host: '127.0.0.1', hmr: false, watch: null, open: false,
      proxy: { '/ws': { target: `ws://127.0.0.1:${bridgePort}`, ws: true }, '/api': { target: `http://127.0.0.1:${bridgePort}` } } },
  });
  await server.listen();
  cleanup.push(async () => { try { await server.close(); } catch {} try { rmSync(cacheDir, { recursive: true, force: true }); } catch {} });
  base = `http://127.0.0.1:${vitePort}`;
} else if (!existsSync(join(ROOT, 'dist/index.html'))) { console.error('[feel] --dist needs a build: npm run build'); bridge.kill(); process.exit(1); }

// ---- browser -------------------------------------------------------------------------------
const exe = process.env.PW_EXE || readdirSync(`${process.env.HOME}/.cache/ms-playwright`).filter((d) => d.startsWith('chromium_headless_shell-')).sort()
  .map((d) => `${process.env.HOME}/.cache/ms-playwright/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath: exe, args: ['--autoplay-policy=no-user-gesture-required'] });
cleanup.push(async () => { try { await browser.close(); } catch {} });
// --touch emulates a phone's coarse, hover-less pointer, for rules behind (hover:none) / (pointer:coarse)
const context = await browser.newContext({ viewport: { width: vw, height: vh }, reducedMotion: flag('--reduced-motion') ? 'reduce' : 'no-preference', hasTouch: flag('--touch'), isMobile: flag('--touch') });
// Sound cannot be heard here, so every cue is logged instead: sampled cues (new Audio().play())
// and synthesised ones (oscillators) both land in window.__audioLog with a page timestamp.
await context.addInitScript(() => {
  const log = (window.__audioLog = []);
  const NativeAudio = window.Audio;
  window.Audio = function (src) { const a = new NativeAudio(src); a.__src = src; return a; };
  window.Audio.prototype = NativeAudio.prototype;
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { log.push({ t: Math.round(performance.now()), kind: 'sample', src: String(this.__src || this.src).split('/').slice(-2).join('/'), volume: +this.volume.toFixed(3) }); return play.apply(this, arguments); };
  const AC = window.AudioContext || window.webkitAudioContext;
  // The app sets pitch with frequency.setValueAtTime (scheduled), so frequency.value still reads the
  // default 440 when start() is called; remember the scheduled value instead. Music is square lead
  // (E5-C6) over triangle bass (<= 147Hz), so e.g. a TRIANGLE at 784Hz is an interface blip.
  if (AC) {
    const create = AC.prototype.createOscillator;
    AC.prototype.createOscillator = function () { const o = create.apply(this, arguments); const set = o.frequency.setValueAtTime.bind(o.frequency); o.frequency.setValueAtTime = (v, at) => { o.__hz = v; return set(v, at); }; return o; };
    const start = OscillatorNode.prototype.start; OscillatorNode.prototype.start = function (when) { log.push({ t: Math.round(performance.now()), kind: 'osc', type: this.type, hz: Math.round(this.__hz ?? this.frequency.value) }); return start.apply(this, arguments); };
  }
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(`[pageerror] ${e.message}`); console.log('[pageerror]', e.message); });
page.on('console', (m) => { if (m.type() === 'error') { const text = m.text(); if (/favicon|net::ERR_|Failed to load resource/.test(text)) return; errors.push(`[console.error] ${text}`); console.log('[console.error]', text); } });

const t = {
  page, base, out, errors, sleep, bridgePort, viewport: { width: vw, height: vh },
  log: (...a) => console.log(...a),
  /** Open the office and wait until agents are seated and the title card has gone. query e.g. 'debug&zoom=2'. */
  async open(query = '', { settle = 1500, waitForAgents = true, raw = false } = {}) {
    await page.goto(`${base}/${query ? '?' + query : ''}`, { waitUntil: 'load' });
    if (raw) return;
    await page.waitForFunction((needAgents) => window.__herdrReady && (!needAgents || (window.hs?.model?.agents?.size ?? 0) > 0), waitForAgents, { timeout: 45000 });
    await page.waitForFunction(() => { const l = document.getElementById('loading'); return !l || l.hidden; }, null, { timeout: 15000 }).catch(() => {});
    await sleep(settle);
  },
  /** PNG to <out>/<name>.png. opts: { clip:{x,y,width,height}, selector, fullPage } */
  async shot(name, opts = {}) {
    const path = join(out, `${name}.png`);
    if (opts.selector) await page.locator(opts.selector).first().screenshot({ path });
    else await page.screenshot({ path, clip: opts.clip, fullPage: opts.fullPage });
    console.log('[shot]', path);
    return path;
  },
  /** Real-time burst: `frames` screenshots as fast as `every` ms allows, then one contact sheet
   *  <name>-strip.png (left→right, top→bottom, each tile labelled with its capture time in ms).
   *  Call it right after triggering something (do not await the trigger's animation first). */
  async strip(name, { frames = 8, every = 70, clip, cols = 4, scale = 0.5 } = {}) {
    const files = []; const t0 = Date.now();
    for (let i = 0; i < frames; i++) {
      const due = t0 + i * every; const wait = due - Date.now(); if (wait > 0) await sleep(wait);
      const at = Date.now() - t0; const f = join(out, `${name}-f${String(i).padStart(2, '0')}-${at}ms.png`);
      await page.screenshot({ path: f, clip }); files.push({ f, at });
    }
    return sheet(name, files, cols, scale);
  },
  /** Deterministic sampling of CSS animations/transitions. Runs `trigger` (a function evaluated in
   *  the page, or a Node async fn if opts.node), freezes every running animation, then screenshots
   *  at each fraction in `at` of the longest animation's end time. Returns the animations found:
   *  [{ target, name, duration, delay, easing, iterations }]. Infinite loops are sampled over one
   *  iteration. An empty list means NOTHING animated — i.e. the change was an instant pop. */
  async scrub(name, trigger, { at = [0, 0.25, 0.5, 0.75, 1], clip, cols = 5, scale = 0.5, node = false, arg, within } = {}) {
    await page.evaluate(() => { window.__before = new Set(document.getAnimations()); });
    if (node) await trigger(); else await page.evaluate(trigger, arg);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const found = await page.evaluate((within) => {
      const root = within ? document.querySelector(within) : null;
      const fresh = document.getAnimations().filter((a) => !window.__before.has(a) && a.effect && (!root || root.contains(a.effect.target) || a.effect.target === root));
      window.__scrub = fresh;
      const sel = (el) => !el ? '?' : el.id ? '#' + el.id : (el.tagName || '').toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
      for (const a of fresh) a.pause();
      return fresh.map((a) => { const timing = a.effect.getComputedTiming(); return { target: sel(a.effect.target) + (a.effect.pseudoElement || ''), name: a.animationName || a.transitionProperty || a.id || 'waapi', duration: timing.duration, delay: timing.delay, easing: a.effect.getTiming().easing, iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations }; });
    }, within);
    const files = [];
    for (const fraction of at) {
      await page.evaluate((fr) => { for (const a of window.__scrub) { const tm = a.effect.getComputedTiming(); const span = tm.delay + tm.duration * (tm.iterations === Infinity ? 1 : tm.iterations); a.currentTime = Math.min(span - (fr >= 1 ? 0.01 : 0), span * fr); } }, fraction);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const f = join(out, `${name}-s${String(Math.round(fraction * 100)).padStart(3, '0')}.png`);
      await page.screenshot({ path: f, clip }); files.push({ f, at: `${Math.round(fraction * 100)}%` });
    }
    await page.evaluate(() => { for (const a of window.__scrub) { try { a.finish(); } catch { a.play(); } } window.__scrub = []; });
    await sheet(name, files, cols, scale);
    console.log(`[scrub] ${name}: ${found.length} animation(s)`, JSON.stringify(found));
    return found;
  },
  /** Every animation/transition currently running: [{ target, name, duration, delay, easing, iterations }]. */
  animations() {
    return page.evaluate(() => document.getAnimations().map((a) => { const el = a.effect?.target; const timing = a.effect?.getComputedTiming?.() ?? {};
      const sel = !el ? '?' : el.id ? '#' + el.id : (el.tagName || '').toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
      return { target: sel + (a.effect?.pseudoElement || ''), name: a.animationName || a.transitionProperty || 'waapi', duration: timing.duration, delay: timing.delay, easing: a.effect?.getTiming?.().easing, iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations }; }));
  },
  /** Frame pacing while something happens. Starts sampling requestAnimationFrame, runs `action`
   *  (a Node async fn using t.page), keeps sampling for `ms` more, and returns
   *  { frames, avg, p95, max, over20, over34, over50, longTasks, longestTask, layoutShift } in ms. */
  async frames(action, ms = 1500) {
    await page.evaluate(() => {
      const m = (window.__frames = { deltas: [], long: [], cls: 0, on: true }); let last = performance.now();
      const tick = (now) => { if (!m.on) return; m.deltas.push(now - last); last = now; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      try { m.po = new PerformanceObserver((list) => { for (const e of list.getEntries()) m.long.push(Math.round(e.duration)); }); m.po.observe({ type: 'longtask', buffered: false }); } catch {}
      try { m.ls = new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) m.cls += e.value; }); m.ls.observe({ type: 'layout-shift', buffered: false }); } catch {}
    });
    if (action) await action();
    await sleep(ms);
    return page.evaluate(() => {
      const m = window.__frames; m.on = false; m.po?.disconnect(); m.ls?.disconnect();
      const d = m.deltas.slice(1).sort((a, b) => a - b); const n = d.length || 1; const r = (x) => Math.round(x * 10) / 10;
      return { frames: d.length, avg: r(d.reduce((a, b) => a + b, 0) / n), p95: r(d[Math.floor(n * 0.95)] ?? 0), max: r(d[d.length - 1] ?? 0),
        over20: d.filter((x) => x > 20).length, over34: d.filter((x) => x > 34).length, over50: d.filter((x) => x > 50).length,
        longTasks: m.long.length, longestTask: Math.max(0, ...m.long), layoutShift: Math.round(m.cls * 10000) / 10000 };
    });
  },
  /** Sound cues since the last call (or since load): [{ t, kind:'sample'|'osc', src|hz, volume }]. Music oscillators are included; filter by kind/ctx as needed. */
  audio({ clear = true } = {}) { return page.evaluate((c) => { const l = window.__audioLog.slice(); if (c) window.__audioLog.length = 0; return l; }, clear); },
  /** First real click anywhere so the page may play sound (browser autoplay rule), without hitting anything. */
  async unlockAudio() { await page.evaluate(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); }); },
  /** With ?debug the test-events tray starts open, and an open tray blocks office input and sleeps
   *  the game loop (as any modal does). Close it before interacting with the office or roster. */
  async closeTray() { await page.evaluate(() => { const tray = document.getElementById('event-debug-tray'); if (tray && !tray.hidden) document.querySelector('.event-debug-toggle')?.click(); }); await sleep(150); },
  /** Fire a preview event from the ?debug tray by its button label (e.g. 'Pay $250', 'Awards'), then close the tray so the office runs. */
  async debugEvent(label) { await page.evaluate(() => { const tray = document.getElementById('event-debug-tray'); if (tray && tray.hidden) document.querySelector('.event-debug-toggle')?.click(); }); await page.locator('#event-debug-tray button', { hasText: label }).first().click(); await this.closeTray(); },
  eval: (fn, arg) => page.evaluate(fn, arg),
  writeJson(name, data) { const f = join(out, `${name}.json`); writeFileSync(f, JSON.stringify(data, null, 2)); console.log('[json]', f); return f; },
};

async function sheet(name, files, cols, scale) {
  const path = join(out, `${name}-strip.png`);
  try {
    const args = [];
    for (const { f, at } of files) args.push('-label', String(at).endsWith('%') ? String(at) : `${at}ms`, f);
    execFileSync('montage', [...args, '-tile', `${cols}x`, '-geometry', `${Math.round(vw * scale)}x+4+4`, '-background', '#222', '-fill', '#fff', '-pointsize', '14', path], { stdio: 'pipe' });
    console.log('[strip]', path, `(${files.length} frames)`);
  } catch (e) { console.log('[strip] montage failed, individual frames kept:', e.message.split('\n')[0]); }
  return path;
}

try {
  const mod = await import(pathToFileURL(resolve(scenarioPath)).href);
  await (mod.default ?? mod.run)(t);
} catch (e) {
  exitCode = 1; console.error('[feel] scenario failed:', e?.stack || e);
  try { await page.screenshot({ path: join(out, 'FAILED.png') }); console.log('[shot]', join(out, 'FAILED.png')); } catch {}
} finally {
  if (errors.length) { console.log(`[feel] ${errors.length} page error(s) during the run`); if (!flag('--keep-going')) exitCode = exitCode || 3; }
  for (const fn of cleanup.reverse()) await fn();
  try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
  console.log('[feel] out:', out);
  process.exit(exitCode);
}
