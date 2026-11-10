import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './run-context.mjs';
import { nativeCodeFixture, serviceRequest, startNativeCodeGateway } from './native-code-service.mjs';
import { ownNativeFixtureTree, stageApplicationComponent } from './application-component.mjs';
import { stageGatewayDependencies } from '../../desktop/stage-gateway-dependencies.mjs';
import { prepareNativeOfficeLaunch,nativeOfficeSpawnEnvironment } from '../../src/integrations/office/resource-host.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function applicationFixture(context, binary, { account, officeStage = false, rendererDist, gatewaySourceRoot, channelSourceRoot } = {}) {
  const sourceRoot=resolve(channelSourceRoot??process.env.KCODER_E2E_NATIVE_CHANNEL_SOURCE_ROOT??repoRoot);
  const gatewaySource = resolve(gatewaySourceRoot ?? sourceRoot, 'apps/kcoder-studio');
  const scratch = await context.createOwnedScratchDirectory('application-os-owner', {
    baseDirectory:process.env.KCODER_E2E_NATIVE_SERVICE_SCRATCH_BASE || await realpath('/var/tmp'), ownedWorkerTraversal:true,requireCleanupConfirmation:true,
  });
  const fixture = await nativeCodeFixture(context, binary, {scratch,account,channelOnly:true});
  const gatewayRoot = resolve(scratch.path,'gateway');
  await mkdir(gatewayRoot,{mode:0o755});
  const pins = [];
  async function sourceTree(from,to) {
    const info = await lstat(from);
    if (info.isDirectory()) {
      await mkdir(to,{mode:0o755});
      for (const name of await readdir(from)) await sourceTree(resolve(from,name),resolve(to,name));
    } else {
      assert.equal(info.isSymbolicLink(),false);assert.equal(info.isFile(),true);
      const bytes = await readFile(from);await writeFile(to,bytes,{mode:0o644,flag:'wx'});
      pins.push({path:'apps/kcoder-studio/'+to.slice(gatewayRoot.length+1),sha256:sha(bytes)});
    }
  }
  for (const name of ['dev-server.mjs','package.json','pnpm-lock.yaml','src','shared','public']) {
    const from=resolve(gatewaySource,name);
    try { await lstat(from); } catch(error) { if(error.code==='ENOENT'&&name==='public')continue;throw error; }
    await sourceTree(from,resolve(gatewayRoot,name));
  }
  // Use the shipped packaging graph; worktrees may link into a global pnpm store.
  const dependencies = await stageGatewayDependencies({
    sourceRoot: gatewaySource, destination: resolve(gatewayRoot,'node_modules'),
  });
  await ownNativeFixtureTree({ root:scratch.path, uid:fixture.uid, gid:fixture.gid }, dependencies.output);
  await context.writeArtifactJson('gateway-dependency-stage.json', dependencies);
  await mkdir(resolve(gatewayRoot,'renderer'),{mode:0o755});
  await sourceTree(rendererDist ?? resolve(sourceRoot,'apps/kcoder-studio/renderer/dist'),resolve(gatewayRoot,'renderer/dist'));
  fixture.gatewayRoot=gatewayRoot;
  await context.writeArtifactJson('scoped-gateway-source-pins.json',pins);
  let modelRequests = 0;
  const modelHttp = [];
  const model = createServer((request, response) => {
    modelRequests++; modelHttp.push({method:request.method,path:new URL(request.url,'http://127.0.0.1').pathname});
    request.resume(); response.writeHead(503); response.end();
  });
  await new Promise(done => model.listen(0, '127.0.0.1', done));
  context.registerPort('application-forbidden-model', model.address().port);
  context.addCleanup('close owned forbidden-model observer', () => new Promise((done, reject) => model.close(error => error ? reject(error) : done())));
  const settings = JSON.parse(await readFile(fixture.settings, 'utf8'));
  settings.integrations.connectivity = { enabled:true };
  if(officeStage){settings.integrations.office={enabled:true};settings.tools={...settings.tools,profile:'full'};}
  settings.credential_store = 'file';
  settings.providers['owned-code'].endpoint = `http://127.0.0.1:${model.address().port}/v1`;
  await writeFile(fixture.settings, JSON.stringify(settings), { mode:0o600 });
  await stageApplicationComponent(context, fixture, { sourceRoot });
  if(officeStage){
    const {stageOfficeResources}=await import(pathToFileURL(resolve(sourceRoot,'apps/kcoder-office-components/packaging/stage-resources.mjs')).href);
    const officeRoot=resolve(fixture.root,'declared-original-office-component');
    const staged=await stageOfficeResources({destination:officeRoot});await ownNativeFixtureTree(fixture,officeRoot);
    const launch=await prepareNativeOfficeLaunch({componentRoot:officeRoot,expectedManifestSha256:staged.manifestSha256});
    Object.assign(fixture.env,nativeOfficeSpawnEnvironment(launch));
    fixture.officeStage={manifestSha256:staged.manifestSha256,nodeSha256:launch.runtime.sha256,nodeMode:launch.runtime.mode};
    await context.writeArtifactJson('original-native-office-stage.json',{...fixture.officeStage,source:'stageOfficeResources + prepareNativeOfficeLaunch + nativeOfficeSpawnEnvironment',privateOwnedResources:true,actualUid:fixture.uid});
  }
  return { ...fixture, modelRequests:() => modelHttp.filter(request=>request.method==='POST').length,
    modelHttpRequests:() => modelRequests, modelHttp:() => structuredClone(modelHttp) };
}

export async function startApplicationGateway(context, fixture, label, { experimental = {}, rpcOpenTimeoutMs } = {}) {
  const ui = await startNativeCodeGateway(context, fixture, label, { rpcOpenTimeoutMs, experimental:{nativeCodeServicesV1:process.platform==='linux',connectivityV1:true,integrationOperationReceiptsV1:true,...(fixture.officeStage?{officeWorkspaceV1:true}:{}), ...experimental} });
  await context.writeArtifactJson(`${label}-capabilities.json`,ui.initialized.capabilities);
  const originalRpc=ui.rpc;let rpcFailures=0,unconfirmedCalls=0;
  ui.rpc=async(method,params)=>{
    try{return await originalRpc(method,params);}
    catch(error){await context.writeArtifactJson(`${label}-original-rpc-failure-${++rpcFailures}.json`,{method,message:error.message});throw error;}
  };
  const call = async (method, payload, options = {}) => {
    const reply = await ui.rpc(method, serviceRequest(ui.scope,payload,options));
    if (method.startsWith('integrations/connectivity/') && !['completed','accepted'].includes(reply.status)) {
      await context.writeArtifactJson(`${label}-connectivity-unconfirmed-${++unconfirmedCalls}.json`, {method,status:reply.status,
        requestId:reply.requestId,operationId:reply.operationId,error:reply.error,observedAt:reply.observedAt});
      assert.fail(`${method}: ${reply.error?.code}`);
    }
    return reply;
  };
  return { ...ui, call };
}
