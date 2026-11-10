import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, lstat, mkdir } from 'node:fs/promises';
import { runE2E } from '../harness/run-context.mjs';

assert.equal(process.env.KCODER_E2E_WEB_EXTERNAL_NETWORK, '1');
const binary = process.env.KCODER_E2E_SEARXNG_PROBE_BIN;
const expected = process.env.KCODER_E2E_SEARXNG_PROBE_SHA256;
const runtime = process.env.KCODER_E2E_SEARXNG_RUNTIME;
assert.match(expected ?? '', /^[a-f0-9]{64}$/);
assert.ok((await lstat(binary)).isFile());
assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), expected);
assert.ok((await lstat(runtime)).isDirectory());
await runE2E(import.meta.url, {testId:'actual-bundled-public-search',tier:'manual-live',cleanupTimeoutMs:30000,
 modelPolicy:'One fixed public Rust query through production BundledWebSearch, SearchDispatchGuard and verified owned runtime; no model, search Key, user profile or installer acceptance. Cold duration includes startup and upstream work.'}, async context => {
  const profile = context.pathInState('profile');
  await mkdir(profile, {recursive:true,mode:0o700});
  const env = {PATH:process.env.PATH,KCODER_CONFIG_DIR:profile,KCODER_SEARXNG_RUNTIME:runtime,KCODER_E2E_WEB_EXTERNAL_NETWORK:'1'};
  for(const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR','CURL_CA_BUNDLE']) {
    if(process.env[name] !== undefined){env[name]=process.env[name];if(/proxy/i.test(name)&&process.env[name])context.registerSecret(process.env[name]);}
  }
  const child = context.spawnOwned('native-bundled-search',binary,[],{cwd:profile,env,stdin:'ignore'});
  let stdout='',stderr='',bytes=0;
  const completed = new Promise((accept,reject)=>{
    child.stdout.on('data',data=>{bytes+=data.length;if(bytes>256*1024){void context.stopOwned('native-bundled-search');reject(Error('Native result budget exceeded'));}else stdout+=data;});
    child.stderr.on('data',data=>{stderr=(stderr+data).slice(-8192);});
    child.once('error',reject);child.once('close',code=>accept(code));
  });
  const timer=setTimeout(()=>{void context.stopOwned('native-bundled-search');},85000);
  let code;try{code=await completed;}finally{clearTimeout(timer);}
  const receipt=JSON.parse(stdout.trim());
  await context.writeArtifactJson('bundled-public-query.json',{...receipt,exitCode:code,stderr:context.redactText(stderr)});
  assert.equal(receipt.logicalRequests,1);assert.equal(receipt.modelCalls,0);assert.equal(receipt.searchKeyUsed,false);assert.ok(receipt.dispatchGuardChecks>=3);
  assert.equal(receipt.cleanupObserved,true);assert.equal(code,0);assert.equal(receipt.passed,true);
  return receipt;
});
