import test from 'node:test';
import assert from 'node:assert/strict';
import { startWindowsRemoteStudio } from './windows-remote-studio.mjs';
const options = {target:'fixture@127.0.0.1', windowsBinary:'/fixture/kcoder.exe', installation:'C:\\fixture',node:'C:\\node.exe',ssh:{port:2222}};
test('remote Windows fixture rejects unbounded transport or shell paths before spawning', async()=>{
  const context = { spawnOwned(){throw new Error('must not spawn');} };
  for(const invalid of [
    {target:'fixture@host;command'}, {installation:"C:\\bad'path"}, {node:''},
    {ssh:{port:0}}, {extraPorts:[65536]}, {windowsBinary:''},
  ]) await assert.rejects(startWindowsRemoteStudio(context,{...options,...invalid}),/Invalid explicit|Invalid SSH/);
});
