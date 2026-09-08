import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from './storage';

test('a failed legacy migration cannot become a blank studio on the next start', () => {
  const directory = mkdtempSync(join(tmpdir(), 'herdr-storage-recovery-'));
  try {
    const path = join(directory, 'studio.json');
    writeFileSync(path, '{incomplete save');
    expect(() => new Storage(directory)).toThrow();
    expect(() => new Storage(directory)).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{incomplete save');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
