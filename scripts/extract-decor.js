#!/usr/bin/env node
// The office room sheets (assets/raw/.../office/floor*.png, 600x800) draw their room in the top
// 600 rows and park the room's loose furniture in the 200-row strip below it. This cuts each
// prop out of that strip into public/assets/gds/decor with a manifest. Needs ImageMagick.
//
// The strip is not a clean palette: alongside the props it holds pieces of the room's own floor,
// staff sprites, and — because these sheets cover pools, spas, kitchens and arcades as well as
// offices — plenty of furniture no office would have. Heuristics on size, skin and outline all
// misfire on that mix (a potted tree has no dark keyline; a floor tile has 45 colours), so the
// finding is automatic and the choosing is an explicit list. Run with --survey to dump every
// island it can see, numbered, when picking again.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RAW = 'assets/raw/game-dev-story-graphics/graphics/office';
const OUT = 'public/assets/gds/decor';
const STRIP_Y = 600, STRIP_W = 600, STRIP_H = 200;
const TOUCH = 2;   // how close another object may come before a prop counts as overlapped

/** Props worth putting in an office, picked by eye off the survey sheet. */
const KEEP = new Set([
  'floor0_550_23',   // white meeting table
  'floor11_550_20',  // dark executive desk, tray on top
  'floor12_550_23',  // glass bench
  'floor13_550_24',  // wooden bench
  'floor14_550_21',  // blue table, mascot toy
  'floor1_551_24',   // white bench
  'floor16_550_23',  // brown desk, wrapped gift
  'floor17_551_24',  // brown counter, cake
  'floor18_208_40',  // noticeboard
  'floor18_244_45',  // potted tree
  'floor3_287_0',    // pair of potted plants
  'floor35_550_16',  // wooden shelf, chest and globe
  'floor5_550_23',   // dark table, pot on top
]);

const sheets = fs.readdirSync(RAW).filter((f) => /^floor\d+\.png$/.test(f)).sort();

/** Every island of opaque pixels in one sheet's strip, as {id, x, y, w, h}. */
function islands(file) {
  const [w] = execSync(`identify -format "%w %h" ${file}`).toString().trim().split(' ').map(Number);
  const d = execSync(`convert ${file} -depth 8 rgba:-`, { maxBuffer: 1e9 });
  const alpha = (x, y) => d[((y + STRIP_Y) * w + x) * 4 + 3];
  const seen = new Uint8Array(STRIP_W * STRIP_H);
  const found = [];
  for (let y = 0; y < STRIP_H; y++) for (let x = 0; x < STRIP_W; x++) {
    if (alpha(x, y) < 40 || seen[y * STRIP_W + x]) continue;
    const stack = [[x, y]]; seen[y * STRIP_W + x] = 1;
    let x0 = x, y0 = y, x1 = x, y1 = y, n = 0;
    while (stack.length) {
      const [cx, cy] = stack.pop(); n++;
      if (cx < x0) x0 = cx; if (cy < y0) y0 = cy; if (cx > x1) x1 = cx; if (cy > y1) y1 = cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= STRIP_W || ny >= STRIP_H) continue;
        if (seen[ny * STRIP_W + nx] || alpha(nx, ny) < 40) continue;
        seen[ny * STRIP_W + nx] = 1; stack.push([nx, ny]);
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (n < 70 || bw < 10 || bh < 10 || bw > 110) continue;   // specks, and the room's floor slab
    found.push({ id: `${path.basename(file, '.png')}_${x0}_${y0}`, x: x0, y: y0, w: bw, h: bh });
  }
  // These sheets are assembled scenes, not sprite atlases: objects are drawn overlapping. An
  // island with a neighbour right against it may have had part of itself painted over by that
  // neighbour and will come out looking sliced — the whiteboard on floor36 lost its left half to
  // a desk that way. Flag them; whether the damage matters is a judgement call for the eye, so
  // KEEP decides and this only warns.
  return found.map((it) => ({ ...it, crowded: found.some((o) => o !== it
    && o.x <= it.x + it.w + TOUCH && o.x + o.w + TOUCH >= it.x
    && o.y <= it.y + it.h + TOUCH && o.y + o.h + TOUCH >= it.y) }));
}

const survey = process.argv.includes('--survey');
const dir = survey ? '/tmp/decor-survey' : OUT;
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const found = [];
for (const s of sheets) {
  const file = `${RAW}/${s}`;
  for (const it of islands(file)) {
    if (!survey && !KEEP.has(it.id)) continue;
    execSync(`convert ${file} -crop ${it.w}x${it.h}+${it.x}+${STRIP_Y + it.y} +repage ${dir}/${it.id}.png`);
    found.push(it);
  }
}

if (survey) {
  console.log(`${found.length} islands -> ${dir}  (${found.filter((i) => i.crowded).length} touching a neighbour)`);
  for (const it of found) if (it.crowded) console.log(`  crowded: ${it.id}`);
  console.log('montage a numbered sheet with:');
  console.log(`  cd ${dir} && i=0; for f in *.png; do i=$((i+1)); convert "$f" -background '#5a3a2a' -alpha remove -filter point -resize 140x140 -gravity center -extent 150x150 -fill yellow -pointsize 24 -gravity northwest -annotate +3+2 "$i" "t$(printf %03d $i).png"; echo "$i $f"; done; montage t*.png -tile 7x -geometry +3+3 sheet.png`);
  process.exit(0);
}

// the same prop appears in several room sheets; keep one copy
const byHash = new Map();
for (const it of found) {
  const p = `${dir}/${it.id}.png`;
  const h = execSync(`md5sum ${p}`).toString().split(' ')[0];
  if (byHash.has(h)) { fs.unlinkSync(p); continue; }
  byHash.set(h, it);
}
// The old dark bench is an incomplete scene fragment: its far legs were occluded by a table.
// Keep its saved-room ID, but use the complete wooden bench and its actual dimensions.
const completeBench = [...byHash.values()].find(it => it.id === 'floor13_550_24');
if (!completeBench) throw new Error('Complete wooden bench missing from the extracted props');
fs.copyFileSync(`${dir}/${completeBench.id}.png`, `${dir}/floor2_208_0.png`);
byHash.set('legacy-bench', { ...completeBench, id: 'floor2_208_0' });
const items = [...byHash.values()].map(({ id, w, h }) => ({ id, w, h, ...(id === 'floor2_208_0' ? { src: '/assets/gds/decor/floor13_550_24.png' } : {}) })).sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(`${dir}/manifest.json`, JSON.stringify(items, null, 1));
const missing = [...KEEP].filter((k) => !items.some((i) => i.id === k));
if (missing.length) console.warn('WARNING: never found', missing.join(', '));
const crowded = found.filter((it) => it.crowded).map((it) => it.id);
if (crowded.length) console.warn('NOTE: drawn against a neighbour, check for slicing:', crowded.join(', '));
console.log(`kept ${items.length} props`);
