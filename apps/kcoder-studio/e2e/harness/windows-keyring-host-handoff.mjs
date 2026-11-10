import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot } from './run-context.mjs';
import { psLiteral } from './windows-package-probe.mjs';

export async function inspectOwnedHostNode(ps, path) {
  assert.match(path ?? '', /^[D-Zd-z]:\\[^\r\n]+\.exe$/);
  const value = JSON.parse((await ps(`$f=Get-Item -LiteralPath ${psLiteral(path)};if($f.PSIsContainer -or ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $f.Length -ge 268435456){throw 'Node source is unavailable'};@{sha256=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant();bytes=$f.Length;readOnly=$true}|ConvertTo-Json -Compress`)).trim());
  assert.match(value.sha256, /^[a-f0-9]{64}$/); assert.equal(value.readOnly, true);
  assert.ok(Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes < 268435456);
  return value;
}

export async function prepareOwnedHostHandoff(context, options, { owner, root, ps, copy }) {
  assert.match(options.hostCliSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.match(options.hostNodeSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.match(options.hostNode ?? '', /^[D-Zd-z]:\\[^\r\n]+\.exe$/);
  const stat = await lstat(options.hostCli);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size < 512 * 1024 * 1024);
  assert.equal(createHash('sha256').update(await readFile(options.hostCli)).digest('hex'), options.hostCliSha256);
  await copy(options.hostCli, 'host-cli.exe');
  const files = [['windows-keyring-host-probe.mjs', 'host-probe.mjs'], ['app-server-stdio.mjs', 'app-server-stdio.mjs']];
  const hashes = [];
  for (const [source, destination] of files) {
    const path = resolve(repoRoot, 'apps/kcoder-studio/e2e/harness', source);
    hashes.push(createHash('sha256').update(await readFile(path)).digest('hex'));
    await copy(path, destination);
  }
  const node = JSON.parse((await ps(`$source=${psLiteral(options.hostNode)};$destination=Join-Path ${psLiteral(root)} 'host-node.exe';$f=Get-Item -LiteralPath $source;if(!$f.PSIsContainer -and !($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $f.Length -lt 268435456 -and (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ceq ${psLiteral(options.hostNodeSha256)}){[IO.File]::Copy($source,$destination,$false)}else{throw 'Pinned Node source is unavailable'};@{sha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress`)).trim());
  assert.equal(node.sha256, options.hostNodeSha256);
  const fixture = { owner, provider: randomBytes(32).toString('hex'), mcp: randomBytes(32).toString('hex'), canary: randomBytes(32).toString('hex') };
  for (const value of [fixture.provider, fixture.mcp, fixture.canary]) context.registerSecret(value);
  const runtime = { owner, version: 1, cliSha256: options.hostCliSha256, helperSha256: options.helperSha256,
    nodeSha256: node.sha256, probeSha256: hashes[0], stdioSha256: hashes[1] };
  // Raw synthetic values travel only over the protected stdin into this run's private handoff.
  const result = JSON.parse((await ps(`$inputValue=[Console]::In.ReadLine()|ConvertFrom-Json;if($inputValue.fixture.owner -ne ${psLiteral(owner)} -or $inputValue.runtime.owner -ne ${psLiteral(owner)}){throw 'Owned Host input identity changed'};foreach($pair in @(@('host-fixture-source.json',$inputValue.fixture),@('host-runtime.json',$inputValue.runtime))){$path=Join-Path ${psLiteral(root)} $pair[0];$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($pair[1]|ConvertTo-Json -Depth 8 -Compress));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}};@{privateFixtureSaved=$true;runtimeSaved=$true}|ConvertTo-Json -Compress`, JSON.stringify({ fixture, runtime }) + '\n')).trim());
  assert.equal(result.privateFixtureSaved, true); assert.equal(result.runtimeSaved, true);
  await context.writeArtifactJson('owned-host-pinned-runtime.json', runtime);
}
