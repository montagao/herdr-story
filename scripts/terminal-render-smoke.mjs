// DOM and conversation tests use only a temporary mock bridge; no real agent receives a prompt.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
const directory = mkdtempSync(join(tmpdir(), 'herdr-terminal-lines-'));
const port = await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const server = spawn('bun', ['bridge/server.ts', '--mock'], { env: { ...process.env,
  HERDR_STORY_PORT: String(port), HERDR_STORY_HOST: '127.0.0.1', HERDR_STORY_STATE_DIR: directory, HERDR_STORY_MOCK_STATIC: '1',
  STRIPE_RESTRICTED_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_API_KEY: '', REVENUECAT_API_KEY: '', REVENUECAT_SECRET_KEY: '',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stdout.on('data', d => logs += d); server.stderr.on('data', d => logs += d);
const cache = `${process.env.HOME}/.cache/ms-playwright`;
const executablePath = process.env.PW_EXE || readdirSync(cache).filter(n => n.startsWith('chromium_headless_shell-')).sort().map(n => `${cache}/${n}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath });
try {
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw Error(logs);
    try { if ((await fetch(`${url}/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(url); await page.waitForFunction(() => window.hs?.office?.pods?.length);
  const result = await page.evaluate(async () => {
    const { dialog, client, model } = window.hs;
    const agents = [...model.agents.values()]; client.watchOutput = () => () => {};
    const call = client.call.bind(client);
    client.call = (method, params, options) => method === 'agent.read'
      ? Promise.resolve({ read: { text: 'Initial output' } }) : call(method, params, options);
    await dialog.open(agents[0]);
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await frame();
    const pre = document.querySelector('.terminal-output');
    const show = text => dialog.paintOutput(pre, { text, at: Date.now(), source: 'visible', live: true });
    const lines = Array.from({ length: 300 }, (_, i) => `Line ${i}: stable text`);
    lines[1] = 'https://example.com/a_(b). localhost:7788/test!';
    lines[2] = '<img src=x onerror=alert(1)> javascript:alert(1)';
    lines[30] = 'Select café 🌱 here';
    show(lines.join('\n')); await frame();
    const original = [...pre.children], link = pre.querySelector('a');
    if (!original[30]?.textContent.includes('café')) throw Error(JSON.stringify({count: original.length, sample: original.slice(27, 33).map(n => n.textContent), start: pre.textContent.slice(0, 250)}));
    const selected = original[30].firstChild, offset = selected.textContent.indexOf('café');
    const selection = getSelection(); selection.setBaseAndExtent(selected, offset + 4, selected, offset);
    pre.scrollTop = 140;
    let added = 0, removed = 0;
    const observer = new MutationObserver(records => { for (const record of records) if (record.target === pre) { added += record.addedNodes.length; removed += record.removedNodes.length; } });
    observer.observe(pre, { subtree: true, childList: true, characterData: true });
    lines[120] = 'Only this line changed';
    show(lines.join('\n')); show(lines.join('\n') + '\nSkipped intermediate frame'); show(lines.join('\n'));
    await frame();
    const unchanged = original.filter((node, i) => i !== 120).every(node => node.parentNode === pre);
    const selectionKept = selection.toString() === 'café' && selection.anchorNode === selected && selection.anchorOffset > selection.focusOffset;
    const stableLink = pre.querySelector('a') === link;
    const scrolled = pre.scrollTop;
    observer.disconnect();
    let mutations = 0; const equal = new MutationObserver(records => mutations += records.length);
    equal.observe(pre, { childList: true, subtree: true, characterData: true }); show(lines.join('\n')); await frame(); equal.disconnect();
    // Moving the terminal viewport forward retains surviving row nodes and selection endpoints.
    lines.shift(); lines.push('Appended output'); show(lines.join('\n')); await frame();
    const rollingKept = original[30].parentNode === pre && selection.toString() === 'café';
    const links = [...pre.querySelectorAll('a')].map(a => ({ href: a.href, rel: a.rel, text: a.textContent }));
    const exact = pre.textContent === lines.join('\n');
    const safe = !pre.querySelector('img,script');
    // A scheduled paint must not survive switching to another conversation.
    show('Obsolete pane output'); await dialog.open(agents[1]); await frame();
    const isolated = !document.querySelector('.terminal-output').textContent.includes('Obsolete pane output');
    return { unchanged, selectionKept, rollingKept, stableLink, scrolled, mutations, added, removed, exact, safe, isolated, links };
  });
  console.log(JSON.stringify(result));
  for (const key of ['unchanged', 'selectionKept', 'rollingKept', 'stableLink', 'exact', 'safe', 'isolated']) assert.equal(result[key], true, key);
  assert.equal(result.scrolled, 140); assert.equal(result.mutations, 0);
  assert.equal(result.added, 1); assert.equal(result.removed, 1);
  assert.equal(result.links[0].href, 'https://example.com/a_(b)'); assert.equal(result.links[1].href, 'http://localhost:7788/test');
  assert(result.links.every(link => link.rel === 'noopener noreferrer'));
  assert.deepEqual(errors, []);
  console.log('PASS changed-line rendering, stable links and reverse selection, rolling viewport, scroll retention, unchanged-screen zero mutations, safe text, and cancelled obsolete paints');
} finally {
  await browser.close();
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) return resolve(); server.once('exit', resolve); server.kill(); });
  rmSync(directory, { recursive: true, force: true });
}
