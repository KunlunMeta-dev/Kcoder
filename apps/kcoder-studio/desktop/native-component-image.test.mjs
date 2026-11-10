import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stageNativeWindowsComponentImage, packagedNativeWindowsComponentEnvironment } from './native-component-image.mjs';
function pe(library) {
  const bytes=Buffer.alloc(4096);bytes.write('MZ');bytes.writeUInt32LE(128,60);
  bytes.write('PE\0\0',128);bytes.writeUInt16LE(0x8664,132);bytes.writeUInt16LE(library?0x2000:0,150);
  return bytes;
}
test('packaging pins both actual PE resource bytes and the finite addon ABI without granting Native authority', async t => {
  const root=await mkdtemp(join(tmpdir(),'owned-native-image-stage-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bin=join(root,'bin');await mkdir(bin);const library=join(root,'library.dll');
  await writeFile(library,pe(true));await writeFile(join(bin,'kcoder.exe'),pe(false));
  const pin=await stageNativeWindowsComponentImage({library,destination:bin});
  assert.equal(pin.abiVersion,1);assert.equal(pin.addonBinary,'kcoder-native-image.node');
  const metadata={nativeWindowsComponentImage:pin};
  const env=await packagedNativeWindowsComponentEnvironment({resourcesPath:root,appMetadata:metadata,platform:'win32'});
  assert.deepEqual(JSON.parse(Buffer.from(env.KCODER_NATIVE_COMPONENT_IMAGE_BINDING_V1,'base64url').toString('utf8')),
    {schemaVersion:1,abiVersion:1,addonPath:join(bin,pin.addonBinary),addonSha256:pin.addonSha256,programSha256:pin.programSha256});
  assert.deepEqual(await packagedNativeWindowsComponentEnvironment({resourcesPath:root,appMetadata:metadata,platform:'win32',remoteThin:true}),{});
  const bytes=await readFile(join(bin,pin.addonBinary));bytes[500]^=1;await writeFile(join(bin,pin.addonBinary),bytes);
  await assert.rejects(packagedNativeWindowsComponentEnvironment({resourcesPath:root,appMetadata:metadata,platform:'win32'}),/RESOURCE_INVALID/);
});
