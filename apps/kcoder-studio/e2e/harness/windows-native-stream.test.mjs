import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
test('actual PS5 native streams preserve bytes and nonzero exit, bound output and settle timeout',{skip:process.platform!=='win32'},async()=>{
  const root=process.env.KCODER_E2E_NATIVE_STREAM_ROOT;assert.ok(root,'Exact owned test root required');
  const path=fileURLToPath(new URL('windows-native-stream.verify.ps1',import.meta.url));
  const body="& ([ScriptBlock]::Create([IO.File]::ReadAllText('"+path.replaceAll("'","''")+"'))) -Root '"+root.replaceAll("'","''")+"' -Node '"+process.execPath.replaceAll("'","''")+"' -Harness '"+dirname(path).replaceAll("'","''")+"'";
  await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(body,'utf16le').toString('base64')],{timeout:30000,windowsHide:true,maxBuffer:1024*1024});
  const result=JSON.parse(await readFile(join(root,'verification.json'),'utf8'));
  assert.equal(result.passed,true);assert.equal(result.powerShellMajor,5);assert.equal(result.normal.ExitCode,23);assert.equal(result.exactStdout,true);assert.equal(result.exactStderr,true);assert.equal(result.overflow.OutputLimitExceeded,true);assert.equal(result.timeout.TimedOut,true);
});
