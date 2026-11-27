// Compare identical Bash probes built from two source revisions, without models.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRunContext, verifyRunContextIntegrity } from './tui-lab/lib/run-context.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binaries = { before: await realpath(process.argv[2]), after: await realpath(process.argv[3]) };
const owner = await realpath(process.argv[4]);
const delayLibrary = await realpath(process.argv[5]);
const sourceRevisions = { before: process.env.BASH_BENCH_BEFORE_REVISION, after: process.env.BASH_BENCH_AFTER_REVISION };
if (!Object.values(sourceRevisions).every(value => /^[0-9a-f]{40}$/.test(value || ''))) throw new Error('explicit source commit identities required');
const rounds = 3;
const layout = await createRunContext({
  description: 'bash-output-before-after', scenario: 'tool-latency',
  workspaceTemplate: path.join(repo, 'tests/fixtures/minimal'),
  out: path.join(repo, 'target/test/agent-tool-latency'),
}, 'bash-output', { cwd: repo, now: new Date(), pid: process.pid, platform: process.platform });
const producer = `import os, sys, time
variant = sys.argv[1]
os.write(1, b'BASH_PROBE_START\\n')
if variant == 'quiet':
    time.sleep(2)
else:
    count = 1024 if variant == 'burst' else 200
    for _ in range(count):
        data = memoryview(b'x' * 65536)
        while data:
            data = data[os.write(1, data):]
        if variant == 'paced':
            time.sleep(0.01)
os.write(1, b'\\nBASH_PROBE_END\\n')
`;
const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TERM'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const hashes = {};
for (const [name, filename] of Object.entries({ ...binaries, owner, delayLibrary })) hashes[name] = createHash('sha256').update(await readFile(filename)).digest('hex');
const samples = [], processes = new Map();
const driverSha256 = createHash('sha256').update(await readFile(path.join(repo, 'crates/kcoder_tools/examples/bash_latency_probe.rs'))).digest('hex');
const meta = { binaries, hashes, owner, delayLibrary, rounds, sourceRevisions, driverSha256, profile: 'dev; identical driver and explicit 30s command timeout',
  scope: 'real BashTool + native command owner + live task snapshot; excludes Engine, CLI startup and model',
  cpu: os.cpus()[0]?.model, load: os.loadavg(),
  cases: [
    { name: 'quiet', variant: 'quiet', detail: '2s sleep, two short markers' },
    { name: 'burst', variant: 'burst', detail: '64 MiB continuous stdout' },
    { name: 'paced', variant: 'paced', detail: '12.5 MiB stdout; 200 chunks, 10ms producer sleep per chunk' },
    { name: 'paced_fsync_50ms', variant: 'paced', slowSync: true, detail: 'same paced command; controlled LD_PRELOAD injection of 50ms per fsync/fdatasync in probe only, not native disk speed' },
  ] };
await writeFile(path.join(layout.dir, 'meta.json'), JSON.stringify(meta, null, 2));
console.log(`ARTIFACTS ${layout.dir}`);

async function run(name, scenario, round) {
  const label = `${scenario.name}-${round}-${name}`;
  const workspace = path.join(layout.workspace, label);
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(path.join(workspace, 'producer.py'), producer);
  const args = [binaries[name], workspace, owner, scenario.variant];
  const probeEnv = scenario.slowSync ? { ...env, LD_PRELOAD: delayLibrary } : env;
  const child = spawn(args[0], args.slice(1), { cwd: workspace, env: probeEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.set(child.pid, child);
  let stdout = '', stderr = '', exceeded = false;
  const timer = setTimeout(() => { exceeded = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 45000);
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await writeFile(path.join(layout.dir, `${label}.stdout.json`), stdout);
    await writeFile(path.join(layout.dir, `${label}.stderr.log`), stderr);
    if (code || exceeded) throw new Error(`${label} failed: code=${code}; ${stderr.slice(-1600)}`);
    const row = { name, case: scenario.name, round, ...JSON.parse(stdout) };
    if (!row.valid || !row.owned_worker_settled) throw new Error(`${label} incomplete`);
    samples.push(row);
    console.log(`${label} ${row.elapsed_ms.toFixed(2)}ms`);
    await writeFile(path.join(layout.dir, 'samples.json'), JSON.stringify(samples, null, 2));
  } finally {
    clearTimeout(timer);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    processes.delete(child.pid);
  }
}

try {
  for (const scenario of meta.cases) {
    for (let round = 0; round <= rounds; round++) {
      for (const name of round % 2 ? ['after', 'before'] : ['before', 'after']) await run(name, scenario, round);
    }
  }
  const median = rows => rows.map(r => r.elapsed_ms).sort((a,b) => a-b)[Math.floor(rows.length / 2)];
  const comparison = meta.cases.map(scenario => {
    const before = median(samples.filter(r => r.name === 'before' && r.case === scenario.name && r.round > 0));
    const after = median(samples.filter(r => r.name === 'after' && r.case === scenario.name && r.round > 0));
    return { case: scenario.name, before_ms: before, after_ms: after, saved_ms: before-after, reduction_percent: (before-after)/before*100 };
  });
  await verifyRunContextIntegrity(layout, { platform: process.platform });
  await writeFile(path.join(layout.dir, 'comparison.json'), JSON.stringify({ meta, comparison, samples }, null, 2));
  console.log(JSON.stringify(comparison, null, 2));
} finally {
  for (const [pid] of processes) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  await writeFile(path.join(layout.dir, 'cleanup.json'), JSON.stringify({ remaining_owned_processes: processes.size }));
}
