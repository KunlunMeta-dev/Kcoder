import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

for(const explicit of [false,true])test(`actual installer selects ${explicit?'explicit override':'durable default'} without touching host units`,{skip:process.platform!=='linux'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'relay-owned-installer-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'apps/kcoder-relay/src/install-local.mjs');
  await mkdir(dirname(source),{recursive:true,mode:0o700});
  for(const name of ['install-local.mjs','config.mjs','client-identity.mjs','admin-auth.mjs'])await copyFile(new URL('../src/'+name,import.meta.url),join(dirname(source),name));
  const sourceBinary=join(root,'apps/kcoder-studio/src/source-app-server-binary.js');
  await mkdir(dirname(sourceBinary),{recursive:true,mode:0o700});
  await copyFile(new URL('../../kcoder-studio/src/source-app-server-binary.js',import.meta.url),sourceBinary);
  await writeFile(join(root,'package.json'),JSON.stringify({type:'module'}));
  const envFile=join(root,'runtime.env');
  await writeFile(envFile,'KCODER_RELAY_REGISTRATION_KEY=owned-registration-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ\nKCODER_RELAY_GATEWAY_SECRET=owned-gateway-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ\nKCODER_RELAY_PUBLIC_URL=https://relay.example.test\n',{mode:0o600});
  const ownedHome=join(root,'owned-home'),durable=join(root,'persistent-state');
  const override=join(root,'override/identity.json');
  const script=`import os from 'node:os';import child from 'node:child_process';import{syncBuiltinESMExports}from'node:module';
    os.homedir=()=>${JSON.stringify(ownedHome)};const calls=[];
    child.execFileSync=(file,args)=>{if(file!=='systemctl')throw Error('unexpected command');calls.push(args);};
    syncBuiltinESMExports();await import(${JSON.stringify(pathToFileURL(source).href)});
    if(calls.length!==3)throw Error('unexpected calls');console.log('owned-install-complete');`;
  const env={...process.env,XDG_STATE_HOME:durable,LOCALAPPDATA:durable,KCODER_RELAY_ENV_FILE:envFile,KCODER_RELAY_PUBLIC_URL:'https://relay.example.test',KCODER_RELAY_REGISTRATION_KEY:'owned-registration-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ',KCODER_RELAY_GATEWAY_SECRET:'owned-gateway-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'};
  delete env.KCODER_RELAY_IDENTITY_FILE;delete env.KCODER_RELAY_SERVERS_FILE;
  if(explicit)env.KCODER_RELAY_IDENTITY_FILE=override;
  const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env,timeout:3000});
  assert.match(result.stdout,/owned-install-complete/);
  const unit=await readFile(join(ownedHome,'.config/systemd/user/kcoder-cyx-relay-client.service'),'utf8');
  assert.ok(unit.includes('KCODER_RELAY_IDENTITY_FILE='+ (explicit?override:join(durable,'kcoder-relay/client-identity.json'))));
  assert.doesNotMatch(unit,/owned-registration-key|owned-gateway-secret/);
  const gatewayUnit=await readFile(join(ownedHome,'.config/systemd/user/kcoder-cyx-relay-gateway.service'),'utf8');
  for(const text of [unit,gatewayUnit]){assert.ok(text.includes('KCODER_RELAY_ENV_FILE='+envFile));assert.ok(text.includes('KCODER_RELAY_IDENTITY_FILE='+(explicit?override:join(durable,'kcoder-relay/client-identity.json'))));assert.doesNotMatch(text,/owned-registration-key|owned-gateway-secret/);}
});
