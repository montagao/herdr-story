import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkPublication } from './check-publication';

const files = checkPublication();
const temp = mkdtempSync(join(tmpdir(), 'herdr-source-'));
const root = join(temp, 'herdr-story');
mkdirSync('release', { recursive: true });
const archive = resolve('release', `herdr-story-source-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`);
try {
  for (const path of files) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(path, target);
  }
  execFileSync('tar', ['-czf', archive, '-C', temp, 'herdr-story']);
  console.log(`Prepared ${archive}\n${files.length} files; no Git history. Review docs/publishing.md before publishing.`);
} finally { rmSync(temp, { recursive: true, force: true }); }
