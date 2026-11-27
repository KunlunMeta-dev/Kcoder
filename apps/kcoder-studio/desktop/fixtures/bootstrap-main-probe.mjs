// Evaluate the actual host wiring with synthetic Electron ports and real owned Node children.
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startGateway } from '../gateway-process.mjs';
import * as startup from '../startup-window.mjs';
import { createResourcePreparationOwner } from '../resource-preparation-owner.mjs';
import { createDesktopSessionRenewal } from '../session-renewal.mjs';
import * as policy from '../security-policy.mjs';
import * as windowsStartup from '../windows-profile-startup.mjs';
import { registerStorageLocations } from '../storage-locations-controller.mjs';
import * as storageInstallation from '../storage-installation.mjs';

const scenario=process.argv[3]||'held',profileCase=scenario.startsWith('profile-'),storageCase=scenario.startsWith('storage-stop-'),installationCase=scenario.startsWith('storage-install-');
const root=process.argv[2],fixture=join(root,'gateway.mjs'),controllers=[],starts=[],instances=[],pids=[];
const mainOverride=process.env.KCODER_BOOTSTRAP_MAIN_MODULE;
const ownedEnvironment={PATH:process.env.PATH||'/usr/bin:/bin',HOME:root,USERPROFILE:root,
  XDG_CONFIG_HOME:join(root,'.config'),XDG_CACHE_HOME:join(root,'.cache'),KCODER_HOME:root,
  KCODER_CONFIG_DIR:root,KCODER_CACHE_DIR:join(root,'cache'),KCODER_STUDIO_DATA_DIR:root,
  KCODER_STUDIO_DESKTOP_USER_DATA_DIR:root};
if(installationCase)for(const name of Object.keys(ownedEnvironment))if(name.startsWith('KCODER_'))delete ownedEnvironment[name];
// Imported startup adapters execute in this process, outside the VM context.
for(const name of Object.keys(process.env))delete process.env[name];
Object.assign(process.env,ownedEnvironment);
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes});return{promise,resolve};};
const ready=deferred(),held=deferred(),exited=deferred(),restarted=deferred(),recoveryPrimed=deferred(),releaseRecovery=deferred(),preparation=deferred();
const diagnostics=[];
async function within(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('owned fixture deadline: '+diagnostics.join('\n'))),5000);})]);}finally{clearTimeout(timer);}}
let relayDefault,profileLaunchInput;
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
let exitFacts,window,menuCallbacks,storageOptions,refreshCalls=0,dialogCount=0,relaunchCalls=0,storageChoice;
const installationOrder=[];
const handlers=new Map();
class Window extends EventEmitter {
  constructor(options){super();window=this;this.options=options;this.destroyed=false;this.url='about:blank';
    this.webContents=Object.assign(new EventEmitter(),{id:1,mainFrame:{url:this.url},isDestroyed:()=>this.destroyed,isLoadingMainFrame:()=>false,getURL:()=>this.url,send(){},executeJavaScript:async()=>{refreshCalls++;if(scenario==='refresh-error')throw Error('owned view unavailable');},setWindowOpenHandler(){}});}
  isDestroyed(){return this.destroyed;}isVisible(){return true;}isFocused(){return true;}show(){}hide(){}focus(){}isMinimized(){return false;}setMenu(){}setMenuBarVisibility(){}
  async loadURL(url){this.url=url;this.webContents.mainFrame.url=url;this.emit('ready-to-show');if(scenario==='refresh-error'&&starts.length>1)throw Error('owned view unavailable');if(scenario==='initial-crash'&&starts.length===1){await instances[0].stop();throw Error('owned initial connection closed');}}
}
const app=Object.assign(new EventEmitter(),{isPackaged:scenario==='profile-package',isReady:()=>false,setName(){},setPath(){},getLocale:()=> 'en',
  getPath:()=>root,getAppPath:()=>root,getVersion:()=> 'owned-fixture',commandLine:{hasSwitch:()=>false},requestSingleInstanceLock:()=>true,releaseSingleInstanceLock(){},whenReady:()=>Promise.resolve(),quit(){},
  relaunch(){relaunchCalls++;},exit(code){exitFacts={code,heldPid:pids[1],heldAlive:alive(pids[1]),ownedAlive:pids.filter(alive)};exited.resolve();}});
let cookieSets=0;
const desktopSession={cookies:{set:async()=>{cookieSets++;if(cookieSets===2&&scenario==='window-closed'){window.destroyed=true;window.emit('closed');}}},setCodeCachePath(){},setPermissionRequestHandler(){},setPermissionCheckHandler(){}};
const fakeProcess=Object.assign(new EventEmitter(),{platform:process.platform,execPath:process.execPath,resourcesPath:root,
  argv:installationCase?['owned-studio','--prepare-windows-startup','--storage-first-launch-user-data',join(root,'dialog')]:['owned-studio'],cwd:()=>root,env:{...ownedEnvironment},
  stdout:{write(...args){const callback=args.at(-1);if(typeof callback==='function')callback();}},stderr:{write(){}}});
const quiet={log(...args){if(String(args[0]).startsWith('KCoder Studio desktop ready:'))ready.resolve();},warn(...args){if(String(args[0]).startsWith('KCoder Studio gateway restarted'))restarted.resolve();},error(...args){if(diagnostics.length<8)diagnostics.push(args.map(value=>value?.stack??String(value)).join(' ').slice(0,4096));}};
const context=createContext({process:fakeProcess,console:quiet,setTimeout,clearTimeout,AbortController,URL,Buffer});
const start=options=>{
  const index=starts.length,controller=new AbortController();controllers.push(controller);
  if (!index) {relayDefault=options.env.KCODER_STUDIO_RELAY_DEFAULT_URL;profileLaunchInput={profile:options.env.KCODER_STUDIO_DESKTOP_PROFILE,host:options.env.KCODER_STUDIO_DESKTOP_HOST,store:options.env.KCODER_STUDIO_SERVERS_STORE,inline:options.env.KCODER_STUDIO_SERVERS};}
  const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
  const pending=startGateway({...options,nodeBinary:process.execPath,gatewayScript:fixture,cwd:root,timeoutMs:4000,stopGraceMs:50,signal,
    env:{...options.env,HOME:root,KCODER_HOME:root,KCODER_CONFIG_DIR:root,KCODER_STUDIO_DATA_DIR:root,
      KCODER_BOOTSTRAP_MODE:index&&['held','storage-stop-pending'].includes(scenario)?'held':index&&scenario==='storage-stop-relaunch'?'bad-url':'ready',KCODER_BOOTSTRAP_PID_FILE:join(root,'pids')},
    onStdout:chunk=>{const match=String(chunk).match(/OWNED_BOOTSTRAP_PID=(\d+)/);if(match){pids[index]=Number(match[1]);if(index)held.resolve();}}});
  starts.push(pending);pending.then(value=>instances.push(value),()=>{});return pending;
};
const overrides={
  electron:{app,nativeImage:{},BrowserWindow:Window,dialog:{showErrorBox(){dialogCount++;}},ipcMain:{handle:(name,handler)=>handlers.set(name,handler),removeHandler:name=>handlers.delete(name)},Menu:{buildFromTemplate:()=>({items:[]}),setApplicationMenu(){}},Tray:class{},session:{fromPartition:()=>desktopSession},shell:{openExternal:async()=>{}},powerMonitor:new EventEmitter()},
  './gateway-process.mjs':{startGateway:start},
  './session-renewal.mjs':{createDesktopSessionRenewal},
  './resource-preparation-owner.mjs':{createResourcePreparationOwner:()=>{
    const owner=createResourcePreparationOwner({timeoutMs:25,warn:()=>{}});
    if(scenario==='storage-stop-unconfirmed')void owner.run(()=>preparation.promise);
    return owner;
  }},
  './storage-locations-controller.mjs':{registerStorageLocations:options=>{storageOptions=options;return registerStorageLocations(options);}},
  './windows-profile-startup.mjs':{...windowsStartup,retryWindowsGatewayStorageStartup:scenario==='storage-stop-relaunch'
    ?async({restart})=>{await restart();recoveryPrimed.resolve();await releaseRecovery.promise;return false;}
    :windowsStartup.retryWindowsGatewayStorageStartup},
  './startup-window.mjs':{...startup,createStartupWindow:()=>({ready:Promise.resolve(),dispose(){}})},
  './packaged-resource-startup.mjs':{preparePackagedStartupResources:async()=>profileCase?{}:null},
  './download-controller.mjs':{registerDownloads:()=>()=>{}},
  './tray-controller.mjs':{createDesktopTray:()=>({dispose(){}})},
  './desktop-icons.mjs':{desktopIconPaths:()=>({}),registerTaskbarIcon(){}},
  './application-menu.mjs':{applicationMenuTemplate:callbacks=>{menuCallbacks=callbacks;return[];}},
  './additional-window.mjs':{openAdditionalWindow:async()=>null,sendDesktopMenuCommand(){}},
  './desktop-menu-controller.mjs':{registerDesktopMenu(){}},
  './directory-dialog-controller.mjs':{registerDirectoryDialog(){}},
  './gateway-startup-failure.mjs':{showGatewayStorageRecovery:async()=>false},
  './gateway-env.mjs':{createDesktopGatewayConfig:async()=>({token:'owned-desktop-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ',env:{KCODER_STUDIO_DATA_DIR:root,KCODER_STUDIO_RELAY_DEFAULT_URL:'https://owned-operator.invalid',...(profileCase?{KCODER_STUDIO_DESKTOP_PROFILE:'owned-main-profile',KCODER_STUDIO_SERVERS_STORE:join(root,'servers.json')}:{})}})},
  '../src/studio-login-link.js':{studioDataDirectory:()=>root},
  './desktop-port.mjs':{resolveDesktopPort:async()=>0},
  './packaged-paths.mjs':{packagedRuntimePaths:()=>({kcoder:process.execPath,supervisor:process.execPath})},
  './security-policy.mjs':policy,
  './widget-isolation/controller.mjs':{configureWidgetProcessIsolation(){},createNativeWidgetIsolationController:()=>({dispose(){}})},
};
if(installationCase){
 overrides['./storage-installation.mjs']={...storageInstallation,
  configureStorageFirstLaunchDialog:({app,userData})=>{app.setPath('userData',userData);app.setPath('sessionData',userData);},
  chooseStorageFirstLaunch:async options=>{
   installationOrder.push('choose');
   const responses=scenario==='storage-install-custom'?[1,2,0]:[scenario==='storage-install-cancel'?3:0];
   const picks=[join(root,'Custom Data'),join(root,'Custom Cache')];
   storageChoice=await storageInstallation.chooseStorageFirstLaunch({...options,dialog:{showMessageBox:async()=>({response:responses.shift()}),
    showOpenDialog:async()=>({canceled:false,filePaths:[picks.shift()]})}});
   return storageChoice;
  }};
 overrides['../src/storage-operation-client.mjs']={createStorageOperationClient:()=>({
  async initialize(roots){
   installationOrder.push('initialize');
   if(!storageChoice)throw Error('initialization started before first-launch confirmation');
   if(roots.dataRoot!==storageChoice.dataRoot||roots.cacheRoot!==storageChoice.cacheRoot)throw Error('first-launch choice changed');
   const record={version:1,revision:1,...roots};
   await mkdir(roots.dataRoot,{recursive:true});await mkdir(roots.cacheRoot,{recursive:true});await mkdir(join(root,'.config'),{recursive:true});
   await writeFile(join(root,'.config','kcoder-storage.json'),JSON.stringify(record),{flag:'wx'});
   return record;
  },
  startup(){throw Error('fresh initialization must not migrate default roots');},
  preview(){throw Error('fresh initialization must not create a migration preview');},
 })};
}
const source=new URL(mainOverride||'../main.mjs',import.meta.url),module=new SourceTextModule(await readFile(source,'utf8'),{context,identifier:source.href,initializeImportMeta:meta=>{meta.url=source.href;}});
try{
 await module.link(async specifier=>{
  const namespace=overrides[specifier]??await import(specifier.startsWith('.')?new URL(specifier,source).href:specifier);
  return new SyntheticModule(Object.keys(namespace),function(){for(const[key,value]of Object.entries(namespace))this.setExport(key,value);},{context});
 });
 await module.evaluate();
 if(installationCase){
  await within(exited.promise);
  let record=null;try{record=JSON.parse(await readFile(join(root,'.config','kcoder-storage.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  console.log(JSON.stringify({exitFacts,starts:starts.length,installationOrder,storageChoice,record,
   defaultNativeExists:await lstat(join(root,'.config','kcoder')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;})}));
 }else{
 if(scenario==='storage-stop-relaunch'){await within(ready.promise);await instances[0].stop();await within(recoveryPrimed.promise);}
 else if(scenario==='storage-stop-unconfirmed'){await within(ready.promise);}
 else if(profileCase){await within(ready.promise);}
 else if(scenario==='storage-stop-pending'){await within(ready.promise);await instances[0].stop();await within(held.promise);}
 else if(scenario==='held'){await within(ready.promise);await instances[0].stop();await held.promise;}
 else{if(scenario!=='initial-crash'){await within(ready.promise);await instances[0].stop();}await within(Promise.race([restarted.promise,exited.promise]));}
 const exitedBeforeQuit=Boolean(exitFacts);
 const startsBeforeQuit=starts.length;
 if(storageCase){storageOptions.stopInstance({operationId:'owned-storage-stop'});releaseRecovery.resolve();}
 else app.emit('before-quit',{preventDefault(){}});
 if(scenario==='quit-menu'){menuCallbacks.newWindow();await new Promise(resolve=>setImmediate(resolve));}
 await within(exited.promise);
 if(storageCase)await new Promise(resolve=>setTimeout(resolve,300));
 console.log(JSON.stringify({exitFacts,starts:starts.length,startsBeforeQuit,relaunchCalls,syntheticElectron:true,realOwnedGatewayProcesses:true,relayDefault,exitedBeforeQuit,refreshCalls,dialogCount,profileLaunchInput}));
 }
}finally{
 releaseRecovery.resolve();preparation.resolve();
 for(const controller of controllers)controller.abort();
 await Promise.allSettled(starts);
 await Promise.allSettled(instances.map(instance=>instance.stop()));
}
