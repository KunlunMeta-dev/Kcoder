import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function physicalLines(bytes) {
  if (!bytes.length) return 0;
  let lines = 0;
  for (const byte of bytes) if (byte === 10) lines++;
  return lines + (bytes.at(-1) === 10 ? 0 : 1);
}

export function inspectFile(root, path) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw new Error(`Outside repository: ${path}`);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) return { path, kind: 'symlink' };
  if (!stat.isFile()) return { path, kind: 'external' };
  const physical = relative(realpathSync(root), realpathSync(absolute));
  if (physical === '..' || physical.startsWith('..' + sep) || isAbsolute(physical)) throw new Error(`Outside repository through symlink: ${path}`);
  const bytes = readFileSync(absolute);
  const utf16 = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
    : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : null;
  if (utf16) {
    try {
      const decoded = new TextDecoder(utf16, { fatal: true }).decode(bytes);
      return { path, kind: 'text', lines: physicalLines(Buffer.from(decoded)) };
    } catch { return { path, kind: 'undecodable' }; }
  }
  if (bytes.includes(0)) {
    const source = new Set(['.rs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.sh', '.ps1', '.toml', '.json', '.jsonc', '.yaml', '.yml', '.md', '.css', '.html', '.xml', '.xsd']);
    if (!source.has(extname(path).toLowerCase())) return { path, kind: 'binary' };
  }
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { path, kind: 'undecodable' }; }
  const lfs = bytes.subarray(0, 128).toString().startsWith('version https://git-lfs.github.com/spec/v1\n');
  return { path, kind: lfs ? 'lfs-pointer' : 'text', lines: physicalLines(bytes) };
}

export function evaluate(rows, policy, { strict = false } = {}) {
  const violations = [], debt = [], warnings = [], resources = [], other = [];
  for (const row of rows) {
    const resource = policy.resources[row.path];
    if (resource) {
      resources.push({ ...row, ...resource });
      if (row.kind === 'symlink' || row.kind === 'external' || row.kind === 'lfs-pointer')
        violations.push({ ...row, reason: 'Managed resource must remain a regular materialized file' });
      if (resource.sha256 && row.sha256 !== resource.sha256)
        violations.push({ ...row, reason: 'Managed upstream resource hash changed; review provenance before updating policy' });
      continue;
    }
    if (row.kind === 'undecodable' || row.kind === 'lfs-pointer' || row.kind === 'external') {
      violations.push({ ...row, reason: 'Unclassified non-text content; register its provenance explicitly' });
      continue;
    }
    if (row.kind !== 'text') { other.push(row); continue; }
    if (row.lines > policy.maxLines) {
      const baseline = policy.debt[row.path];
      if (!strict && baseline && row.lines <= baseline.lines) debt.push(row);
      else violations.push({ ...row, reason: baseline ? 'Existing debt grew or strict mode enabled' : 'New oversized file' });
    } else if (row.lines >= policy.warnLines) warnings.push(row);
  }
  return { violations, debt, warnings, resources, other };
}

export function check(root, options = {}) {
  const policy = JSON.parse(readFileSync(resolve(root, 'scripts/quality/file-size-policy.json'), 'utf8'));
  if (policy.maxLines !== 3000) throw new Error('The source file ceiling must remain 3000 lines');
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
  const rows = paths.map(path => {
    const row = inspectFile(root, path);
    if (policy.resources[path]?.sha256 && !['symlink', 'external'].includes(row.kind))
      row.sha256 = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
    return row;
  });
  return { maxLines: policy.maxLines, ...evaluate(rows, policy, options) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
    const report = check(root, { strict: process.argv.includes('--strict') });
    if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`File size: ${report.violations.length} violations, ${report.debt.length} existing debt, ${report.warnings.length} near-limit, ${report.resources.length} managed resources`);
      for (const row of report.violations) console.error(`${row.path}: ${row.lines ?? row.kind}: ${row.reason}`);
    }
    process.exitCode = report.violations.length ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
