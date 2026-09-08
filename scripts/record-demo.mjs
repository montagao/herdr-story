import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeDemoAudio } from './demo-audio.mjs';

const base = process.env.DEMO_URL || 'http://127.0.0.1:5173';
const output = resolve(process.argv[2] || 'recordings');
mkdirSync(join(output, 'raw'), { recursive: true });
const cache = `${process.env.HOME}/.cache/ms-playwright`;
const executablePath = process.env.PW_EXE || readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().map(d => `${cache}/${d}/chrome-headless-shell-linux64/chrome-headless-shell`).pop();
const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
  timezoneId: process.env.DEMO_TIMEZONE || 'Australia/Melbourne',
  recordVideo: { dir: join(output, 'raw'), size: { width: 1280, height: 720 } } });
const page = await context.newPage();
const failures = [];
page.on('pageerror', error => failures.push(error.message));
page.on('websocket', socket => {
  const url = new URL(socket.url());
  // Vite's development reload channel is unrelated to the live bridge.
  if (url.host === new URL(base).host && url.pathname === '/' && url.searchParams.has('token')) return;
  failures.push(`Unexpected live connection: ${socket.url()}`);
});
page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) failures.push('Unexpected API request'); });
let duration;
async function showSlate() {
  await page.evaluate(() => {
    const slate = document.createElement('div'); slate.id = 'recording-slate';
    slate.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483647';
    document.body.append(slate);
  });
  await page.waitForTimeout(700);
}
async function cleanFrame() {
  assert.equal(await page.locator('#demo-badge').isVisible(), false, 'Recording hides the demo badge');
  assert.equal(await page.locator('.demo-foot').isVisible(), false, 'Recording hides the demo footer');
  assert.equal(await page.locator('#hud').isVisible(), true, 'Revenue HUD stays visible');
  assert.equal(await page.locator('.hud-label').textContent(), 'Last 30 days');
  assert.equal(await page.locator('.hud-range').isVisible(), false, 'Recording has no interval control');
  assert.equal(await page.locator('.hud-range-menu').isVisible(), false);
  assert.equal(await page.locator('.hud-break').isVisible(), false, 'Recording has no breakdown popovers');
}
// A tour of the captured office: the room, a desk at work, its conversation, the whiteboards,
// the trophy shelf, the books. Each beat is a caption plus one thing the office does.
const beat = async (ms, chapter, text, act) => {
  await page.evaluate(([chapter, text, act]) => { window.herdrDemo.caption(chapter, text); new Function('d', act)(window.herdrDemo); }, [chapter, text, act]);
  await cleanFrame();
  await page.waitForTimeout(ms);
};
const hero = `const all = [...d.model.agents.values()]; const hero = all.find(a => a.agent_status === 'working') ?? all[0];`;
try {
  await page.goto(`${base}/?demo=1&capture=1&seed=11`);
  await page.waitForFunction(() => window.herdrDemo?.ready);
  await page.evaluate(() => document.fonts.ready);
  // A brief black slate gives the encoded video an exact trim point. Browser startup and
  // encoder shutdown durations do not reliably match the recording's wall-clock duration.
  await showSlate();
  const began = Date.now();
  await page.evaluate(() => document.getElementById('recording-slate').remove());
  await page.mouse.move(1225, 701);
  await beat(4500, 'THE OFFICE', 'Every agent gets a desk.', 'd.office.fitOffice();');
  await beat(4500, 'AT WORK', 'Real tasks, on real projects.', `${hero} d.office.followAgent(hero.pane_id);`);
  await beat(5000, 'TALK TO ANYONE', 'Click a desk. Read the terminal. Reply.', `${hero} void d.dialog.open(hero);`);
  await page.keyboard.press('Escape');
  await beat(5000, 'WHITEBOARDS', 'One per project: goals, checklists, the crew.', 'd.office.followAgent(undefined); d.studio.open("boards");');
  await page.screenshot({ path: join(output, 'herdr-story-poster-new.png') });
  await beat(5000, 'THE TROPHY SHELF', 'Milestones and releases, with their real links.', 'd.studio.open("trophies");');
  await page.keyboard.press('Escape');
  await beat(4000, 'STRIPE + REVENUECAT', 'Your revenue. Right here in the office.', 'd.office.fitOffice();');
  await beat(3000, 'HERDR STORY', 'Give your AI agents a place to work.', '');
  duration = (Date.now() - began) / 1000;
  assert.deepEqual(failures, []);
  await showSlate();
} finally {
  await context.close(); await browser.close();
}
const raw = await page.video().path();
const detection = spawnSync('ffmpeg', ['-hide_banner','-i',raw,'-vf','blackdetect=d=0.2:pix_th=0.05:pic_th=0.99','-an','-f','null','-'], { encoding:'utf8' });
assert.equal(detection.status, 0, 'Could not inspect recording slate');
const slates = [...detection.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)];
assert.ok(slates.length, 'Recording must contain an opening trim slate');
const start = Number(slates[0][2]);
const blackStarts = [...detection.stderr.matchAll(/black_start:([\d.]+)/g)];
assert.ok(blackStarts.length >= 2, 'Recording must contain an ending trim slate');
const end = Number(blackStarts.at(-1)[1]);
assert.ok(end > start + 20, 'Recording must contain the complete story');
// The screencast encoder can stretch its timestamp stream under load. Keep both ends, then
// normalize the captured segment to the measured story duration instead of cutting its tail.
const tempo = duration / (end - start);
const soundtrack = join(output, 'raw', 'demo-soundtrack.wav');
writeDemoAudio(soundtrack, duration);
const movie = join(output,'herdr-story-demo.mp4');
const pendingMovie = join(output,'herdr-story-demo-new.mp4');
execFileSync('ffmpeg', ['-y','-hide_banner','-loglevel','error','-ss',String(start),'-i',raw,'-i',soundtrack,
  '-t',String(duration),'-map','0:v:0','-map','1:a:0','-vf',`trim=duration=${end-start},setpts=${tempo}*(PTS-STARTPTS)`,
  '-c:v','libx264','-preset','medium','-crf','19',
  '-pix_fmt','yuv420p','-r','30','-c:a','aac','-b:a','128k','-movflags','+faststart',pendingMovie]);
const verified = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_format','-show_streams','-of','json',pendingMovie], { encoding:'utf8' }));
assert.equal(verified.streams.find(s=>s.codec_type==='video').codec_name,'h264');
assert.equal(verified.streams.find(s=>s.codec_type==='audio').codec_name,'aac');
renameSync(pendingMovie, movie);
renameSync(join(output,'herdr-story-poster-new.png'), join(output,'herdr-story-poster.png'));
writeFileSync(join(output,'README.txt'), `Herdr Story product video\n\n${verified.format.duration} seconds · 1280 × 720 · H.264/AAC MP4\nA captured real office (public/demo/office.json): its desks, boards, trophies and revenue.\nThe demo badge and controls are hidden in the video.\nIncludes an original chiptune bed and captions.\n\nReplay: open /?demo=1 in your Herdr Story app\nRe-capture: npm run demo:export · Re-record: npm run demo:record\n`);
console.log(JSON.stringify({ movie, duration: verified.format.duration, bytes: verified.format.size, poster: join(output,'herdr-story-poster.png') }));
