// A scheduled interactive task starts this entry. The existing native supervisor
// owns the actor and its native children; no personal process is adopted.
(async () => {
  const { join } = require('node:path');
  const { readFile, writeFile, mkdir } = require('node:fs/promises');
  const { execFileSync } = require('node:child_process');
  const root = process.argv[5];
  if (process.argv.includes('--desktop-action-worker')) {
    const { runWindowsDesktopActionUnknown } = await import('./windows-desktop-action-unknown.mjs');
    console.log(JSON.stringify(await runWindowsDesktopActionUnknown(root))); return;
  }
  const input = JSON.parse(await readFile(join(root, 'desktop-input.json'), 'utf8'));
  const ticks = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks.ToString()`], { encoding: 'utf8', timeout: 10000 }).trim();
  await writeFile(join(root, 'probe-owner.json'), JSON.stringify({ owner: input.owner, pid: process.pid,
    creationTicks: ticks, creationKind: 'process-start-time' }));
  process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = join(root, 'app/resources/bin/kcoder-process-supervisor.exe');
  const { spawnWindowsSupervised } = await import('./owned-process.mjs');
  await mkdir(join(root, 'process-status'), { recursive: true });
  const { child, identity } = spawnWindowsSupervised(process.execPath,
    [...process.argv.slice(1), '--desktop-action-worker'], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }, join(root, 'process-status'));
  let output = '', error = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { error = (error + value).slice(-4096); });
  const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await identity.readyPromise;
  const code = await ended;
  if (code !== 0) throw new Error(`Owned desktop actor failed (${code}): ${error}`);
  console.log(output.trim());
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
