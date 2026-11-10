import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot } from './run-context.mjs';
import { psLiteral } from './windows-package-probe.mjs';

export const privateKeyringSources = Object.freeze([
  ['windows-private-keyring-probe.mjs', 'host-probe.mjs'],
  ...['windows-private-keyring-write.mjs', 'windows-private-keyring-reopen.mjs', 'windows-private-keyring-state.mjs',
    'windows-private-credential-native.mjs', 'windows-private-credential-review.mjs', 'migration-no-inference.mjs',
    'app-server-stdio.mjs'].map(leaf => [leaf, leaf]),
]);
export async function preparePrivateKeyringHandoff(context, options, { owner, root, ps, copy }) {
  for (const name of ['hostCliSha256', 'hostNodeSha256', 'helperSha256']) assert.match(options[name], /^[a-f0-9]{64}$/);
  const stat = await lstat(options.hostCli); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size < 512 * 1024 * 1024);
  assert.equal(createHash('sha256').update(await readFile(options.hostCli)).digest('hex'), options.hostCliSha256);
  await copy(options.hostCli, 'host-cli.exe');
  const sources = [{ leaf: 'host-cli.exe', sha256: options.hostCliSha256 }, { leaf: 'security-helper.exe', sha256: options.helperSha256 }];
  for (const [leaf, destination] of privateKeyringSources) {
    const path = resolve(repoRoot, 'apps/kcoder-studio/e2e/harness', leaf);
    sources.push({ leaf: destination, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
    await copy(path, destination);
  }
  const node = JSON.parse((await ps(`$source=${psLiteral(options.hostNode)};$destination=Join-Path ${psLiteral(root)} 'host-node.exe';if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne '${options.hostNodeSha256}'){throw 'Original Node changed'};[IO.File]::Copy($source,$destination,$false);@{sha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress`)).trim());
  assert.equal(node.sha256, options.hostNodeSha256); sources.push({ leaf: 'host-node.exe', sha256: node.sha256 });
  const fixture = { owner, values: Array.from({ length: 4 }, () => randomBytes(32).toString('hex')) };
  for (const value of fixture.values) context.registerSecret(value);
  const runtime = { owner, version: 2, scenario: 'private-rpc', helperSha256: options.helperSha256, nodeSha256: node.sha256,
    cliSha256: options.hostCliSha256, sources };
  // Synthetic fixture values travel only through protected stdin, never argv or artifacts.
  const result = JSON.parse((await ps(`$v=[Console]::In.ReadLine()|ConvertFrom-Json;if($v.fixture.owner -ne ${psLiteral(owner)} -or $v.runtime.owner -ne ${psLiteral(owner)}){throw 'Original private fixture changed'};foreach($pair in @(@('private-keyring-source.json',$v.fixture),@('host-runtime.json',$v.runtime))){$stream=[IO.File]::Open((Join-Path ${psLiteral(root)} $pair[0]),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($pair[1]|ConvertTo-Json -Depth 8 -Compress));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}};@{saved=$true}|ConvertTo-Json -Compress`, JSON.stringify({ fixture, runtime }) + '\n')).trim());
  assert.equal(result.saved, true); await context.writeArtifactJson('owned-private-keyring-runtime.json', runtime);
}
