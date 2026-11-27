import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { runE2E } from './run-context.mjs';

const sourceUrl = new URL('./windows-studio-ui-probe.cjs', import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function actualRemovalLoop(root, artifacts, unconfirmed) {
  const source = await readFile(sourceUrl, 'utf8');
  const loop = source.indexOf('    for (let attempt = 0; !directInstall');
  assert.ok(loop >= 0);
  const guard = source.lastIndexOf('    nativeInputRecoveryUnconfirmed ||= ', loop);
  const start = guard >= 0 ? guard : loop;
  const end = source.indexOf('    if (!cleaned) process.exitCode', loop);
  assert.ok(end > loop);
  const run = new AsyncFunction('fs', 'path', 'root', 'artifacts', 'nativeInputRecoveryUnconfirmed', 'delay',
    'let cleaned=false,result={passed:true}; const directInstall=false,process={exitCode:0};\n' + source.slice(start, end) + '\nreturn cleaned;');
  return run(fs, path, root, artifacts, unconfirmed, async () => {});
}

test('the actual UI probe cleanup retains the original root and unknown input marker', async () => {
  await runE2E(import.meta.url, { tier: 'harness-unit', modelPolicy: 'actual cleanup source with owned files only; no Windows, keyboard, child or model' }, async context => {
    const root = context.pathInState('studio-ui-original'), artifacts = context.pathInState('artifacts');
    await mkdir(root); await mkdir(artifacts);
    const marker = path.join(root, 'native-input-foreground.json');
    await writeFile(marker, '{"imeToggleState":"started"}');
    const cleaned = await actualRemovalLoop(root, artifacts, false);
    await context.writeArtifactJson('ui-cleanup-marker.json', { cleaned, rootRetained: fs.existsSync(root), markerRetained: fs.existsSync(marker) });
    assert.equal(cleaned, false); assert.equal(fs.existsSync(marker), true);
    return { markerRetained: true, nativeWindows: false };
  });
});

async function actualFunction(name, asyncFunction = false) {
  const source = await readFile(sourceUrl, 'utf8');
  const start = source.indexOf((asyncFunction ? 'async ' : '') + 'function ' + name + '(');
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start);
  return new vm.Script('(' + source.slice(start, end + 2) + ')').runInNewContext({ setTimeout, clearTimeout });
}

test('the input hider is joined by its original child before restoration can proceed', async () => {
  const stop = await actualFunction('stopOwnedInputHider', true);
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  let kills = 0, finished = false;
  child.kill = () => { kills++; return true; };
  const pending = stop(child, 1000).then(value => { finished = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false); assert.equal(kills, 1);
  child.exitCode = 0; child.emit('exit', 0);
  assert.equal(await pending, true);
  assert.equal(child.listenerCount('exit'), 0); assert.equal(child.listenerCount('error'), 0);
  const refused = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() { throw Error('PRIVATE_KILL_CANARY'); } });
  assert.equal(await stop(refused, 20), false);
});

test('only a confirmed restore with the original marker absent can permit state cleanup', async () => {
  const confirmed = await actualFunction('nativeInputRestoreConfirmed');
  assert.equal(confirmed({ status: 0, stdout: '{"restored":true}' }, false), true);
  for (const response of [{ status: 1, stdout: '{"restored":true}' }, { status: null, stdout: '' },
    { status: 0, stdout: 'PRIVATE_NON_JSON_CANARY' }, { status: 0, stdout: '{"restored":false,"outcome":"unknown"}' }]) {
    assert.equal(confirmed(response, false), false);
  }
  assert.equal(confirmed({ status: 0, stdout: '{"restored":true}' }, true), false);
});

test('the actual finally source still stops owned resources after a malformed restore receipt', async () => {
  await runE2E(import.meta.url, { tier: 'harness-unit', modelPolicy: 'actual finally source and owned files with managed child ports; no Windows native calls' }, async context => {
    const source = await readFile(sourceUrl, 'utf8');
    const start = source.indexOf('    clearTimeout(deadline);'), end = source.indexOf('\n  }\n  console.log(JSON.stringify({ result, cleaned', start);
    assert.ok(start >= 0 && end > start);
    const root = context.pathInState('studio-ui-original'), artifacts = context.pathInState('artifacts');
    await mkdir(root); await mkdir(artifacts);
    const marker = path.join(root, 'native-input-foreground.json'); await writeFile(marker, '{"imeToggleState":"started"}');
    let stops = 0, runtimeClosed = false;
    const ports = { fs, path, root, artifacts, clearTimeout, deadline: null, directInstall: false,
      closeInstalledApp: undefined, socket: { close() {} }, backgroundChild: null, nativeInputProbe: true,
      app: { pid: 123, exitCode: 0 }, spawnSync: () => ({ status: 0, stdout: 'PRIVATE_RESTORE_CANARY' }),
      stopApp: () => { stops++; }, taskHostProbe: false, runtimeAutomation: { async close() { runtimeClosed = true; } },
      modelFixture: null, delay: async () => {}, __dirname: '/owned',
      nativeInputRestoreConfirmed: await actualFunction('nativeInputRestoreConfirmed'),
      stopOwnedInputHider: await actualFunction('stopOwnedInputHider', true) };
    const names = Object.keys(ports), run = new AsyncFunction(...names,
      'let result={passed:true},cleaned=false,nativeInputRecoveryUnconfirmed=false;const process={exitCode:0};\n'
      + source.slice(start, end) + '\nreturn {result,cleaned,exitCode:process.exitCode};');
    const receipt = await run(...Object.values(ports));
    assert.equal(stops, 1); assert.equal(runtimeClosed, true); assert.equal(fs.existsSync(marker), true);
    assert.equal(receipt.result.passed, false); assert.equal(receipt.exitCode, 1); assert.equal(receipt.cleaned, false);
    assert.equal(JSON.stringify(receipt).includes('PRIVATE_RESTORE_CANARY'), false);
    assert.equal(fs.existsSync(path.join(artifacts, 'native-input-recovery-required.json')), true);
    let restoreCalls = 0;
    ports.backgroundChild = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: () => false });
    ports.spawnSync = () => { restoreCalls++; throw Error('must not restore while the owned hider is unconfirmed'); };
    const blocked = await run(...Object.values(ports));
    assert.equal(restoreCalls, 0); assert.equal(stops, 2); assert.equal(blocked.result.passed, false);
    assert.equal(fs.existsSync(marker), true);
    return { originalMarkerRetained: true, ownedAppStopAttempted: true, ownedRuntimeClosed: true,
      unconfirmedHiderBlocksInput: true, rawErrorExposed: false };
  });
});

test('a lost restore receipt retains owned state even when its marker cannot be read', async () => {
  await runE2E(import.meta.url, { tier: 'harness-unit', modelPolicy: 'owned cleanup receipt boundary only; no input or native host' }, async context => {
    const root = context.pathInState('studio-ui-original'), artifacts = context.pathInState('artifacts');
    await mkdir(root); await mkdir(artifacts);
    assert.equal(await actualRemovalLoop(root, artifacts, true), false);
    assert.equal(fs.existsSync(root), true);
    return { stateRetained: true, nativeWindows: false };
  });
});

test('confirmed ordinary cleanup still deletes only the original owned fixture root', async () => {
  await runE2E(import.meta.url, { tier: 'harness-unit', modelPolicy: 'owned cleanup positive control only; no native host' }, async context => {
    const root = context.pathInState('studio-ui-original'), artifacts = context.pathInState('artifacts');
    await mkdir(root); await mkdir(artifacts);
    assert.equal(await actualRemovalLoop(root, artifacts, false), true);
    assert.equal(fs.existsSync(root), false); assert.equal(fs.existsSync(artifacts), true);
    return { originalRootCleaned: true, peerArtifactsRetained: true, nativeWindows: false };
  });
});
