import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {startWindowsManagedPacFixture,windowsManagedPacPayload} from './windows-managed-pac-fixture.mjs';
import {controlledPacNativeCase,runInstalledNativeWebSearch} from './windows-native-web-search.mjs';

export function validateManagedPacObservation(native,stats,controlledCase){
 assert.equal(native.passed,true);assert.equal(native.realDefaultPublicAcceptance,false);
 assert.equal(native.receipt.provider,'searxng-bundled');assert.equal(native.receipt.sources.length,3);
 assert.deepEqual(native.receipt.sources.map(source=>source.url).sort(),[...controlledCase.expectedSources].sort());
 assert.ok(native.receipt.sources.every(source=>source.readStatus==='summary_only'));
 assert.deepEqual(native.nativeEof,{forcedKill:false,exitCode:0});
 assert.equal(stats.externalConnections,0);assert.ok(stats.pacRequests>0);assert.ok(stats.connectAccepted>0);assert.ok(stats.tlsAccepted>0);assert.ok(stats.originRequests>0);
 for(const field of ['connectDenied','tlsRejected','originDenied','transportErrors'])assert.equal(stats[field],0);
}

export async function runOwnedManagedPacSession(input){
 assert.equal(process.platform,'win32');
 assert.equal(input.nativeBundledControlled,true);assert.equal(input.controlledPacConsent,'1');
 assert.equal(input.nativeConsent,'1');assert.equal(input.externalConsent,'1');
 const root=resolve(input.runRoot),marker=JSON.parse(await readFile(join(root,'.owner.json'),'utf8'));
 assert.equal(marker.owner,input.owner);assert.equal(marker.username,input.username);
 const certificates=JSON.parse(await readFile(join(root,'managed-pac-certificates.json'),'utf8'));
 const controlledCase=controlledPacNativeCase(certificates.fixtureId),payload=windowsManagedPacPayload(certificates.fixtureId);
 assert.equal(controlledCase.nativeQuery,payload.nativeQuery);assert.deepEqual(controlledCase.expectedSources,payload.expectedSources.map(source=>source.url));
 const [caPem,certificatePem,privateKeyPem]=await Promise.all(['managed-ca.pem','managed-leaf.pem','managed-leaf-key.pem'].map(name=>readFile(join(root,name))));
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 assert.equal(sha(caPem),certificates.caSha256);assert.equal(sha(certificatePem),certificates.certificateSha256);
 const installedCli=join(input.installDirectory,'resources/bin/kcoder.exe');
 assert.equal(sha(await readFile(installedCli)),input.expectedCliSha256);
 assert.equal(sha(await readFile(join(input.installDirectory,'resources/searxng/files.sha256.json'))),'7ba9bb086ccd425511325754c280b998ba42398027417d05ace75d17d174a208');
 const addresses=[...new Set((await lookup('www.bing.com',{all:true,verbatim:true})).map(value=>value.address))];
 // The fixture validates every numeric address and only dials its own TLS port.
 const ports=[];
 const fixture=await startWindowsManagedPacFixture({fixtureId:certificates.fixtureId,caPem,certificatePem,privateKeyPem,allowedConnectAddresses:addresses},{registerPort:(label,port)=>ports.push({label,port})});
 try {
 assert.equal(fixture.fixture.nativeQuery,controlledCase.nativeQuery);assert.deepEqual(fixture.fixture.expectedSources.map(source=>source.url),controlledCase.expectedSources);
 const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
 const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
 let ran=false,finished=false,running=false;
 const stop=async()=>{if(finished)return;finished=true;const stats=await fixture.stop();send({kind:'stopped',owner:input.owner,stats});lines.close()};
 lines.once('close',()=>{if(!finished){void fixture.stop().finally(()=>process.exit(2))}});
 lines.on('line',async line=>{
  try{
   const command=JSON.parse(line);assert.equal(command.owner,input.owner);
   if(command.command==='run'){
    assert.equal(ran,false);assert.equal(running,false);ran=true;running=true;
    const environment={...process.env,SSL_CERT_FILE:join(root,'managed-ca.pem')};delete environment.KCODER_SEARXNG_RUNTIME;
    try{
     const native=await runInstalledNativeWebSearch({binary:installedCli,directory:join(root,'controlled-native-web'),environment,expectedCommit:input.expectedCommit,expectedCliSha256:input.expectedCliSha256,nativeConsent:'1',externalConsent:'1',scope:'bundled-parent-route',controlledCase});
     const stats=fixture.stats();validateManagedPacObservation(native,stats,controlledCase);
     send({kind:'query-result',owner:input.owner,passed:true,native,stats,controlledCase});
    }catch(error){send({kind:'query-result',owner:input.owner,passed:false,phase:error.nativeWebPhase??'controlled-observation',errorType:error.name,nativeEof:error.nativeEof??null,nativeCalls:error.nativeCalls??[],stats:fixture.stats()})}
    finally{running=false}
   }else if(command.command==='stop'){assert.equal(running,false);await stop()}
   else throw Error('Unsupported owned fixture command');
  }catch{send({kind:'protocol-failed',owner:input.owner});await stop();process.exitCode=1}
 });
 send({kind:'ready',owner:input.owner,fixture:fixture.fixture,ports,fixtureExternalForwarding:false,certificateStoreWrites:0});
 } catch(error) { await fixture.stop(); throw error; }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await runOwnedManagedPacSession(JSON.parse((await readFile(process.argv[2],'utf8')).replace(/^\uFEFF/,'')))}
 catch{console.log(JSON.stringify({kind:'bootstrap-failed'}));process.exitCode=1}
}
