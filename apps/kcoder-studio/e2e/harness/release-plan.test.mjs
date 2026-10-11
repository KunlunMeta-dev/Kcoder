import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releasePlan, releaseGroupSuites, releaseEnvironmentNames } from './release-plan.mjs';
import { modelIndependentSuites } from '../suite-registry.mjs';
import { suiteEnvironmentNames } from './runner-options.mjs';

test('release plan reuses registry sets and every explicit suite is registered',()=>{
  assert.deepEqual(releaseGroupSuites('core'),modelIndependentSuites);
  for(const name of Object.keys(releasePlan.studioGroups))assert.ok(releaseGroupSuites(name).length);
  assert.throws(()=>releaseGroupSuites('missing'),/Unknown/);
  assert.ok(releasePlan.commands.some(item=>item.command.includes('cargo test')));
});
test('release prerequisites reach only the suites that require them',()=>{
  const windows='suites/gateway/windows-installer-lifecycle.e2e.mjs';
  assert.ok(suiteEnvironmentNames(windows).includes('KCODER_E2E_WINDOWS_NEW_INSTALLER'));
  assert.ok(suiteEnvironmentNames('suites/browser/tauri-model-configuration-summary.e2e.mjs').includes('KCODER_E2E_TAURI_BIN'));
  assert.equal(releaseEnvironmentNames('suites/gateway/runtime-target-local.e2e.mjs').includes('KCODER_E2E_WINDOWS_SSH_TARGET'),false);
  assert.equal(suiteEnvironmentNames(windows).includes('AWS_SECRET_ACCESS_KEY'),false);
});

test('runner refuses partial release selections and missing real-model consent before building',()=>{
  for(const args of [['--release-group','core','--suite','auth-multitarget'],['--release-group','real-model']]){
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../run-all.mjs',import.meta.url)),...args],{encoding:'utf8'});
    assert.notEqual(result.status,0);assert.match(result.stderr,/cannot be narrowed|cannot silently omit/);
  }
});
