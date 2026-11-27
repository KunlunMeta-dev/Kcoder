import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import * as relay from '../../../kcoder-relay/src/client-identity.mjs';
import { prepareGatewayRelayStorage } from './gateway-storage-domains.mjs';
import { runOfflineOwnerChild } from './offline-owner-child.mjs';

const operationId='owned-metadata-proof',relayUrl='https://relay.example.test';
const gatewaySecret='owned-source-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const assignment={id:'owned-metadata-gateway',secret:'owned-registration-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'};

function mockOwner(t,{roots=[resolve(tmpdir(),'virtual-owned-source')],payload={},observe,verify,onValidate,runOwner=runOfflineOwnerChild}={}){
  const previousExitListeners=new Set(process.listeners('exit'));
  t.after(()=>{for(const listener of process.listeners('exit'))if(!previousExitListeners.has(listener))process.removeListener('exit',listener);});
  const events=[],frames=[],leases=[],observed=[];
  const rootFacts=roots.map((root,index)=>({root,directoryIdentity:'opaque-root-'+index,
    primaryIdentity:'opaque-primary-'+index,secondaryIdentity:'opaque-secondary-'+index}));
  let initialized=false,last;
  const protocol={
    read(){
      if(!initialized){initialized=true;return {type:'initialize',version:1,operationId,roots:rootFacts,payload};}
      assert.ok(['validateFences','validateOffline'].includes(last.type));
      events.push({event:'parentCheck',frame:last});
      const accepted=onValidate?.(last)!==false;
      if(accepted)events.push({event:'ack',sequence:last.sequence});
      return {type:accepted?'validated':'rejected',version:1,operationId,sequence:last.sequence};
    },
    write(frame){last=structuredClone(frame);frames.push(last);events.push({event:'write',frame:last});},
  };
  const native={
    tryExclusive(root,name,create){
      assert.equal(name,'kcoder-storage-instances.lock');assert.equal(create,false);
      const lease=Object.freeze({root,index:leases.length});leases.push(lease);return lease;
    },
    verify(lease){assert.ok(leases.includes(lease));verify?.(lease);},
    observeEntry(lease,local,kind){
      assert.ok(leases.includes(lease));
      const call={lease,local,kind};observed.push(call);events.push({event:'nativeObserve',...call});
      return observe?observe(call):JSON.stringify({identity:'opaque-full-128-bit-entry-0123456789abcdef0123456789abcdef',links:kind==='file'?'2':null});
    },
  };
  return {events,frames,leases,observed,run:run=>runOwner({run,native,protocol})};
}

async function gatewayFixture(t){
  const root=await mkdtemp(join(tmpdir(),'offline-native-proof-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'Source'),finalTarget=join(root,'Target');
  const legacyIdentityFile=join(source,'desktop-relay','client-identity.json'),identityFile=join(source,'relay','client-identity.json');
  await mkdir(dirname(legacyIdentityFile),{recursive:true,mode:0o700});
  await writeFile(join(dirname(legacyIdentityFile),'gateway-secret'),gatewaySecret+'\n',{mode:0o600});
  await writeFile(legacyIdentityFile,JSON.stringify({version:1,relayOrigin:relayUrl,
    gatewaySecretHash:createHash('sha256').update(gatewaySecret).digest('hex'),...assignment}),{mode:0o600});
  await relay.prepareInstanceIdentityFile({identityFile,legacyIdentityFile,relayUrl,gatewaySecret});
  return {root,source,finalTarget,identityFile,legacyIdentityFile};
}

function nativeMetadata({lease,local,kind}){
  const path=join(lease.root,local);
  return JSON.stringify({identity:JSON.stringify({opaque128:'fedcba98765432100123456789abcdef',path}),
    links:kind==='directory'?null:String(statSync(path,{bigint:true}).nlink)});
}

function prepare(f,context,extra={}){
  return prepareGatewayRelayStorage({source:f.source,finalTarget:f.finalTarget,relayUrl,phase:'prepareSource',
    ...context,loadRuntime:async()=>relay,...extra});
}

test('mock Native metadata uses the original most-specific held instance lease without a new protocol frame',async t=>{
  const root=resolve(tmpdir(),'virtual-owned-source'),nested=join(root,'nested');
  const f=mockOwner(t,{roots:[root,nested]});
  const value=await f.run((_payload,context)=>context.observeStorageEntry(join(nested,'entry'),'file'));
  assert.equal(value.identity,'opaque-full-128-bit-entry-0123456789abcdef0123456789abcdef');
  assert.deepEqual(f.observed,[{lease:f.leases[1],local:'entry',kind:'file'}]);
  assert.deepEqual(f.frames.map(frame=>frame.type),['validateFences','validateFences','ready','validateFences','validateFences','completed']);
});

test('mock Windows metadata selects the deepest lease across equivalent namespace spellings',async t=>{
  // Run the real protocol with Win32 path rules on every host.
  const moduleUrl=new URL('./offline-owner-child.mjs',import.meta.url);
  const source=await readFile(moduleUrl,'utf8');
  const windowsSource=source
    .replace(/import \{ ([^}]+) \} from 'node:path';/,
      "import { win32 as windowsPaths } from 'node:path'; const { $1 } = windowsPaths;")
    .replaceAll("process.platform === 'win32'",'true')
    .replace("'../storage-lease.mjs'",JSON.stringify(new URL('../storage-lease.mjs',moduleUrl).href));
  const {runOfflineOwnerChild:runOwner}=await import('data:text/javascript;base64,'+Buffer.from(windowsSource).toString('base64'));
  for(const [parent,nested] of [
    [String.raw`\\?\C:\a`,String.raw`C:\a\b`],
    [String.raw`\\?\UNC\s\share\a`,String.raw`\\s\share\a\b`],
  ]){
    assert.ok(parent.length>nested.length,'the shallower namespace spelling must be longer');
    for(const roots of [[parent,nested],[nested,parent]]){
      const f=mockOwner(t,{roots,runOwner});
      const value=await f.run((_payload,context)=>context.observeStorageEntry(nested+'\\entry','file'));
      assert.equal(value.identity,'opaque-full-128-bit-entry-0123456789abcdef0123456789abcdef');
      assert.deepEqual(f.observed,[{lease:f.leases[roots.indexOf(nested)],local:'entry',kind:'file'}]);
      assert.equal(f.observed[0].lease.root,nested);
      assert.deepEqual(f.frames.map(frame=>frame.type),['validateFences','validateFences','ready','validateFences','validateFences','completed']);
    }
  }
});

test('mock Native metadata rejects outside, root-self and noncanonical scopes before observation',async t=>{
  const root=resolve(tmpdir(),'virtual-owned-source'),f=mockOwner(t,{roots:[root]});
  await f.run((_payload,context)=>{
    for(const [path,kind] of [
      ['relative','file'],[root,'directory'],[root+sep,'directory'],
      [join(root+'-peer','entry'),'file'],[join(root,'..','entry'),'file'],
      [root+sep+'nested'+sep+'..'+sep+'entry','file'],[join(root,'entry'),'symlink'],
    ])assert.throws(()=>context.observeStorageEntry(path,kind),{code:'STORAGE_OFFLINE_METADATA_INVALID'});
    return null;
  });
  assert.equal(f.observed.length,0);
});

test('mock Native metadata refuses malformed or asynchronous results without completion',async t=>{
  const cases=[
    ['null','file','null'],['extra field','file',JSON.stringify({identity:'opaque',links:'1',extra:true})],
    ['zero file links','file',JSON.stringify({identity:'opaque',links:'0'})],
    ['directory links','directory',JSON.stringify({identity:'opaque',links:'1'})],
    ['invalid JSON','file','{'],['asynchronous result','file',Promise.resolve('{}')],
  ];
  for(const [name,kind,result] of cases)await t.test(name,async t=>{
    const root=resolve(tmpdir(),'virtual-owned-source'),f=mockOwner(t,{roots:[root],observe:()=>result});
    await assert.rejects(f.run((_payload,context)=>context.observeStorageEntry(join(root,'entry'),kind)),
      error=>error.code==='STORAGE_OFFLINE_METADATA_INVALID'||error instanceof SyntaxError);
    assert.equal(f.frames.some(frame=>frame.type==='completed'),false);
  });
});

test('mock Native observation and lost live lease failures cannot publish a proof',async t=>{
  for(const stage of ['observe','validate'])await t.test(stage,async t=>{
    const root=resolve(tmpdir(),'virtual-owned-source'),error=new Error('owned Native failure');let observed=false;
    const f=mockOwner(t,{roots:[root],observe:()=>{
      observed=true;if(stage==='observe')throw error;
      return JSON.stringify({identity:'opaque',links:'1'});
    },verify:()=>{if(observed&&stage==='validate')throw error;}});
    await assert.rejects(f.run((_payload,context)=>{
      const value=context.observeStorageEntry(join(root,'entry'),'file');
      context.validateOffline({operationId,domain:'owned-source',sourceProof:value});return value;
    }),failure=>failure===error);
    assert.equal(f.frames.some(frame=>frame.type==='validateOffline'),false);
    assert.equal(f.frames.some(frame=>frame.type==='completed'),false);
  });
});

test('mock parent captures each real adopted Relay alias proof before ACK and completion',async t=>{
  const f=await gatewayFixture(t),captured=[];
  const expected={domain:'gateway-relay',source:f.source,finalTarget:f.finalTarget,operationId};
  const owner=mockOwner(t,{roots:[f.source,join(f.source,'relay'),f.finalTarget],observe:nativeMetadata,onValidate:frame=>{
    if(!frame.facts.sourceProof)return;
    const {sourceProof,...scope}=frame.facts;assert.deepEqual(scope,expected);
    assert.ok([f.identityFile,f.legacyIdentityFile].includes(sourceProof.identityFile));
    assert.equal(sourceProof.operationId,operationId);captured.push(structuredClone(sourceProof));
    owner.events.push({event:'capturedProof',sequence:frame.sequence});
  }});
  const value=await owner.run(async(_payload,context)=>{
    const current=await prepare(f,context);
    const legacy=await prepare(f,context,{sourceIdentityFile:'desktop-relay/client-identity.json',sharedIdentityFile:'relay/client-identity.json'});
    owner.events.push({event:'ownerReturned'});return [current,legacy];
  });
  assert.deepEqual(value,captured);assert.equal(captured.length,2);
  assert.equal(captured[0].identities.epochDirectory.identity,captured[1].identities.epochDirectory.identity);
  assert.equal(captured[1].paths.projection,null);await assert.rejects(stat(f.legacyIdentityFile),{code:'ENOENT'});
  for(const event of owner.events.filter(event=>event.event==='capturedProof')){
    const capturedIndex=owner.events.indexOf(event);
    const ackIndex=owner.events.findIndex(item=>item.event==='ack'&&item.sequence===event.sequence);
    assert.ok(capturedIndex<ackIndex);assert.ok(ackIndex<owner.events.findIndex(item=>item.event==='ownerReturned'));
  }
  assert.equal(owner.frames.filter(frame=>frame.facts?.sourceProof).length,2);
  assert.equal(owner.observed.length,5);
  for(const call of owner.observed){
    const path=join(call.lease.root,call.local);
    assert.ok(path.startsWith(f.source+sep));assert.ok(!relative(call.lease.root,path).startsWith('..'));
    if(path.startsWith(join(f.source,'relay')+sep))assert.equal(call.lease,owner.leases[1]);
  }
  assert.deepEqual(owner.frames.at(-1).value,captured);
});

test('mock parent rejection or EOF at the Relay source-proof ACK prevents completion',async t=>{
  for(const stage of ['rejected','EOF'])await t.test(stage,async t=>{
    const f=await gatewayFixture(t),before=await readFile(f.identityFile+'.state-v2/reference.json');
    const owner=mockOwner(t,{roots:[f.source],observe:nativeMetadata,onValidate:frame=>{
      if(!frame.facts.sourceProof)return;
      if(stage==='rejected')return false;
      throw Object.assign(new Error('owned parent EOF'),{code:'STORAGE_OFFLINE_PARENT_UNAVAILABLE'});
    }});
    await assert.rejects(owner.run((_payload,context)=>prepare(f,context)),{
      code:stage==='rejected'?'STORAGE_OFFLINE_PARENT_REJECTED':'STORAGE_OFFLINE_PARENT_UNAVAILABLE',
    });
    assert.equal(owner.frames.filter(frame=>frame.facts?.sourceProof).length,1);
    assert.equal(owner.frames.some(frame=>frame.type==='completed'),false);
    assert.deepEqual(await readFile(f.identityFile+'.state-v2/reference.json'),before);
    await assert.rejects(stat(f.finalTarget),{code:'ENOENT'});
  });
});

test('mock live-fence loss immediately after source-proof ACK still prevents completion',async t=>{
  const f=await gatewayFixture(t),error=new Error('owned fence lost after proof ACK');let proofAccepted=false;
  const owner=mockOwner(t,{roots:[f.source],observe:nativeMetadata,onValidate:frame=>{
    if(frame.facts.sourceProof)proofAccepted=true;
  },verify:()=>{if(proofAccepted)throw error;}});
  await assert.rejects(owner.run((_payload,context)=>prepare(f,context)),failure=>failure===error);
  assert.equal(proofAccepted,true);assert.equal(owner.frames.some(frame=>frame.type==='completed'),false);
});
