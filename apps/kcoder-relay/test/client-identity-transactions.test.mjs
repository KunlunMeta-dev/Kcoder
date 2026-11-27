// Private isolated identity roots and actual processes; no account or Relay traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,mkdir,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareClientIdentity,saveRegisteredClientIdentity,readRegisteredClientIdentity } from '../src/client-identity.mjs';
import { removeRevokedRelayCredentials } from '../../kcoder-studio/src/gateway-relay-instance.js';

const relayUrl='https://relay.example.test',gatewaySecret='owned-internal-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const assigned=id=>({id,secret:'owned-assigned-secret-'+id+'-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'});
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'owned-relay-cas-')),identityFile=join(root,'relay','client-identity.json');
 t.after(()=>rm(root,{recursive:true,force:true}));
 const base={identityFile,relayUrl,gatewaySecret},pending=await prepareClientIdentity(base);
 return {root,base,pending,save:value=>saveRegisteredClientIdentity({...base,enrollmentToken:pending.enrollmentToken,...value})};
}

test('two conflicting assignments cannot both report successful persistence',async t=>{
 const f=await fixture(t),results=await Promise.allSettled([f.save(assigned('assignment-a')),f.save(assigned('assignment-b'))]);
 const winners=results.filter(row=>row.status==='fulfilled');assert.equal(winners.length,1);
 assert.deepEqual(await readRegisteredClientIdentity(f.base),winners[0].value);
});

test('the actual local revocation entrypoint fences a late assignment and later startup',async t=>{
 const f=await fixture(t);await removeRevokedRelayCredentials(f.root,f.base.identityFile);
 await assert.rejects(f.save(assigned('late-assignment')));
 await assert.rejects(prepareClientIdentity(f.base),/revoked|reconciliation/i);
});

test('save and revoke commute to a revoked generation without implicitly preparing another proof',async t=>{
 const f=await fixture(t);await Promise.allSettled([f.save(assigned('assignment-a')),removeRevokedRelayCredentials(f.root,f.base.identityFile)]);
 await assert.rejects(readRegisteredClientIdentity(f.base),/revoked|reconciliation|does not exist/i);
 await assert.rejects(prepareClientIdentity(f.base),/revoked|reconciliation/i);
});

test('replaying the same confirmed assignment is idempotent',async t=>{
 const f=await fixture(t),value=assigned('original');
 await f.save(value);await f.save(value);assert.deepEqual(await readRegisteredClientIdentity(f.base),value);
});

test('revoked startup and access probing never send cached registration credentials',async t=>{
 const f=await fixture(t);await f.save(assigned('original'));
 await removeRevokedRelayCredentials(f.root,f.base.identityFile);
 const {startRegisteredClient,checkRegisteredClientAccess}=await import('../src/client.mjs');
 let sends=0;const fetchImpl=()=>{sends++;throw Error('unexpected network');};
 await assert.rejects(startRegisteredClient({...f.base,url:relayUrl,registrationKey:'owned-registration-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ',fetchImpl}),{code:'RELAY_IDENTITY_REVOKED'});
 assert.equal(await checkRegisteredClientAccess({...f.base,url:relayUrl,fetchImpl}),'revoked');
 assert.equal(sends,0);
});

test('a live control peer rechecks local authority before opening another data channel',async t=>{
 const f=await fixture(t);
 const {createServer}=await import('node:http'),{once}=await import('node:events'),{WebSocketServer}=await import('ws');
 const server=createServer(),peers=new WebSocketServer({server});
 t.after(()=>{peers.close();server.close();server.closeAllConnections?.();});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${server.address().port}`;
 const base={...f.base,relayUrl:url,identityFile:join(f.root,'live/client-identity.json')};
 const pending=await prepareClientIdentity(base);await saveRegisteredClientIdentity({...base,...pending,...assigned('live')});
 let connections=0;peers.on('connection',()=>connections++);
 const connected=once(peers,'connection');
 const {startRegisteredClient}=await import('../src/client.mjs');
 const client=await startRegisteredClient({...base,url,allowInsecure:true});t.after(()=>client.close());
 const [control]=await connected;
 await (await import('../src/client-identity.mjs')).revokeClientIdentity(base);
 const closed=once(control,'close');control.send(JSON.stringify({type:'open',id:'a'.repeat(48)}));
 await closed;assert.equal(connections,1,'a revoked cached assignment never authorizes data connect');
});

test('revocation rejects a profile parent alias before creating any peer directory',async t=>{
 const f=await fixture(t),{symlink,stat}=await import('node:fs/promises');
 const profile='00000000-0000-4000-8000-000000000001',peer=join(f.root,'peer'),profiles=join(f.root,'relay-profiles');
 await mkdir(peer,{mode:0o700});await mkdir(profiles,{mode:0o700});
 await symlink(peer,join(profiles,profile),process.platform==='win32'?'junction':'dir');
 await assert.rejects(removeRevokedRelayCredentials(f.root,join(profiles,profile,'relay/client-identity.json')),/parent changed/);
 await assert.rejects(stat(join(peer,'relay')),{code:'ENOENT'});
});
