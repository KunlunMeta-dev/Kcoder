import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { startOAuthMcpFixture } from './oauth-mcp.mjs';

test('owned issuer issues distinct subjects and rotates only the selected refresh credential', async () => {
  const cleanups = [], secrets = [];
  const context = { addCleanup: (_label, callback) => cleanups.push(callback), registerPort() {}, registerSecret: value => secrets.push(value) };
  try {
    const issuer = await startOAuthMcpFixture(context, { accountSubjects: ['A', 'B'] });
    const authorize = async subject => {
      const url = new URL('/authorize', issuer.root);
      url.search = new URLSearchParams({ subject, redirect_uri: 'http://127.0.0.1/callback', state: 'owned-state', code_challenge: createHash('sha256').update('verifier').digest('base64url') });
      const response = await fetch(url, { redirect: 'manual' });
      const code = new URL(response.headers.get('location')).searchParams.get('code');
      const token = await fetch(issuer.root + '/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: 'verifier', redirect_uri: 'http://127.0.0.1/callback', resource: issuer.root + '/', client_id: 'fixture-client' }) });
      assert.equal(token.status, 200);
      return token.json();
    };
    const a = await authorize('A'), b = await authorize('B');
    assert.ok(a.access_token !== b.access_token && a.refresh_token !== b.refresh_token);
    for (const value of [a.access_token, a.refresh_token, b.access_token, b.refresh_token]) assert.ok(secrets.includes(value));
    const refresh = async token => fetch(issuer.root + '/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, resource: issuer.root + '/', client_id: 'fixture-client' }) });
    const rotated = await refresh(a.refresh_token);
    assert.equal(rotated.status, 200);
    assert.equal((await refresh(a.refresh_token)).status, 400);
    const read = async token => (await (await fetch(issuer.root + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'oauth_probe' } }) })).json()).result.content[0].text;
    assert.equal(await read((await rotated.json()).access_token), 'OAUTH_SUBJECT_A_RESOURCE_A_ONLY');
    assert.equal(await read(b.access_token), 'OAUTH_SUBJECT_B_RESOURCE_B_ONLY');
    issuer.rejectRefresh('B');
    assert.equal((await refresh(b.refresh_token)).status, 400);
    assert.deepEqual(issuer.accountEvents.filter(event => event.type === 'refresh').map(event => event.subject), ['A', 'B']);
    const freshA = await authorize('A');
    issuer.loseNextRefreshResponse('A');
    await assert.rejects(refresh(freshA.refresh_token), TypeError);
    assert.equal((await refresh(freshA.refresh_token)).status, 400, 'A lost refresh response has already consumed its original credential');
    assert.equal(issuer.accountEvents.filter(event => event.type === 'refresh-response-lost' && event.subject === 'A').length, 1);
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
});

test('owned discovered revocation endpoint preserves unsupported tokens and applies lost acknowledgements only once per request',async()=>{
 const cleanups=[],secrets=[];const context={addCleanup:(_label,fn)=>cleanups.push(fn),registerPort(){},registerSecret:value=>secrets.push(value)};
 try{
  const before=[];const issuer=await startOAuthMcpFixture(context,{accountSubjects:['A','U'],providerRevocation:{},beforeRevocationResponse:event=>{before.push(event);}});
  issuer.advertiseProviderRevocation(false);let metadata=await(await fetch(issuer.root+'/.well-known/oauth-authorization-server')).json();assert.equal(metadata.revocation_endpoint,undefined);
  issuer.advertiseProviderRevocation(true);metadata=await(await fetch(issuer.root+'/.well-known/oauth-authorization-server')).json();assert.equal(metadata.revocation_endpoint,issuer.root+'/revoke');
  const authorize=async subject=>{
   const uri=new URL('/authorize',issuer.root);uri.search=new URLSearchParams({subject,redirect_uri:'http://127.0.0.1/callback',state:'owned-state',code_challenge:createHash('sha256').update('verifier').digest('base64url')});
   const reply=await fetch(uri,{redirect:'manual'});const code=new URL(reply.headers.get('location')).searchParams.get('code');
   return(await fetch(issuer.root+'/token',{method:'POST',body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:'verifier',redirect_uri:'http://127.0.0.1/callback',resource:issuer.root+'/',client_id:'fixture-client'})})).json();
  };
  const a=await authorize('A'),u=await authorize('U');
  const revoke=token=>fetch(issuer.root+'/revoke',{method:'POST',body:new URLSearchParams({token,token_type_hint:'refresh_token',client_id:'fixture-client'})});
  issuer.setProviderRevocationMode('A','unsupported');assert.equal((await revoke(a.refresh_token)).status,400);assert.equal(issuer.providerRevocations[0].effectApplied,false);
  const read=async token=>(await fetch(issuer.root+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call'})})).status;
  assert.equal(await read(a.access_token),200);issuer.setProviderRevocationMode('A','accepted');assert.equal((await revoke(a.refresh_token)).status,200);assert.equal(await read(a.access_token),401);
  issuer.setProviderRevocationMode('U','lost-ack');await assert.rejects(revoke(u.refresh_token),TypeError);assert.equal(await read(u.access_token),401);
  assert.equal(issuer.providerRevocations.length,3);assert.equal(before.length,3);assert.equal(issuer.providerRevocations.filter(event=>event.subject==='U').length,1);
  assert.deepEqual(issuer.fixtureErrors,[]);assert.ok([a.access_token,a.refresh_token,u.access_token,u.refresh_token].every(value=>secrets.includes(value)));
  assert.equal(JSON.stringify(issuer.providerRevocations).includes(a.refresh_token),false);assert.equal(JSON.stringify(before).includes(u.access_token),false);
 }finally{for(const fn of cleanups.reverse())await fn();}
});
