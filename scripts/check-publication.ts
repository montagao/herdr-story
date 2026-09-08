import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { sampleOffice } from './demo-sample';

export function sourceFiles() {
  return [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\0').filter(path => path && existsSync(path)))].sort();
}

export function checkPublication(files = sourceFiles()) {
  const errors: string[] = [];
  const forbidden = /(^|\/)(?:\.git|node_modules|dist|captures|recordings|shots|release)(?:\/|$)|^assets\/raw\/|^public\/assets\/gds\/|(?:^|\/)\.env(?:$|\.(?!example$))|\.(?:sqlite|db)(?:-|$)|\.(?:pem|key|log)$/;
  // Report locations only; never print a matched credential. This intentionally modest check
  // supplements review/secret scanning, and is not an anonymizer or a full security audit.
  const credentials = /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
  for (const path of files) {
    if (forbidden.test(path)) { errors.push(`${path}: private/generated file in source`); continue; }
    const stat = lstatSync(path);
    if (!stat.isFile()) { errors.push(`${path}: source must not contain symlinks or special files`); continue; }
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    bytes.toString('utf8').split('\n').forEach((line, i) => {
      if (credentials.test(line)) errors.push(`${path}:${i + 1}: credential-shaped content; review privately`);
    });
  }
  if (readFileSync('public/demo/office.json', 'utf8') !== JSON.stringify(sampleOffice(), null, 2) + '\n')
    errors.push('public/demo/office.json: must match generated fictional sample (npm run demo:sample)');
  if (errors.length) throw new Error(errors.join('\n'));
  return files;
}

if (import.meta.main) {
  try { console.log(`Publication checks passed for ${checkPublication().length} current source files. Git history is not included in this check.`); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
