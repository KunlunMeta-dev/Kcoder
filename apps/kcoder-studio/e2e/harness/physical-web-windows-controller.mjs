import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {spawnWindowsSupervised} from './owned-process.mjs';
assert.equal(process.platform,'win32');
const config=JSON.parse((await readFile(process.argv[2],'utf8')).replace(/^\uFEFF/,''));
const root=resolve(config.root),marker=JSON.parse(await readFile(join(root,'.owner.json'),'utf8'));
assert.equal(marker.owner,config.owner);assert.match(config.owner,/^[a-f0-9-]{36}$/);
const ticks=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks.ToString()`],{encoding:'utf8',windowsHide:true}).trim();
await writeFile(join(root,'probe-owner.json'),JSON.stringify({owner:config.owner,pid:process.pid,creationTicks:ticks,creationKind:'process-start-time'}));
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
let active,finished=false;
input.once('close',()=>{if(!finished){active?.stdin.destroy();process.exit(2)}});
const first=await new Promise(resolve=>input.once('line',line=>resolve(JSON.parse(line))));
assert.equal(first.owner,config.owner);
const privateFiles=[];
function secureFile(path){
 const script="$p='"+path.replaceAll("'","''")+"';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$old=Get-Acl -LiteralPath $p;$oldRules=@($old.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));$before=@{ownerMatchesCurrentSid=($old.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $sid.Value);isProtected=$old.AreAccessRulesProtected;aceCount=$oldRules.Count};$acl=[Security.AccessControl.FileSecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow));Set-Acl -LiteralPath $p -AclObject $acl;$now=Get-Acl -LiteralPath $p;$rules=@($now.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));@{before=$before;ownerMatchesCurrentSid=($now.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $sid.Value);isProtected=$now.AreAccessRulesProtected;aceCount=$rules.Count;singleUserAce=($rules.Count -eq 1 -and $rules[0].IdentityReference.Value -ceq $sid.Value)}|ConvertTo-Json -Compress";
 let output;try{output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';"+script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:10000,maxBuffer:16384}).trim()}catch{throw Error('Owned private settings ACL setup failed')}
 const value=JSON.parse(output);
 assert.equal(value.ownerMatchesCurrentSid,true);assert.equal(value.isProtected,true);assert.equal(value.aceCount,1);assert.equal(value.singleUserAce,true);return value;
}
for(const id of ['ssh-owner','ssh-peer','http-owner','http-peer']){
 const directory=join(root,'profiles',id),profile=join(directory,'config'),workspace=join(directory,'workspace');
 await mkdir(profile,{recursive:true});await mkdir(workspace,{recursive:true});
 const endpoint=id.endsWith('owner')?config.ownerEndpoint:config.peerEndpoint;
 const settings={web:{fetch:{proxyMode:'direct'}},credential_store:'file',max_retries:0,active_provider:'owned',model:id,providers:{owned:{api_format:'openai_chat_completions',endpoint,default_model:id,authentication:{mode:'none'},discover_models:false,no_proxy:true,context_window_tokens:128000,max_output_tokens:1024,output_headroom_tokens:4096}}};
 await writeFile(join(profile,'settings.json'),JSON.stringify(settings));privateFiles.push({id,...secureFile(join(profile,'settings.json'))});
 for(const [leaf,value] of [['program.txt',join(root,'payload/bin/kcoder.exe')],['profile.txt',profile],['owner.txt',config.owner]])await writeFile(join(directory,leaf),Buffer.from(value,'utf16le'));
 const shim=await readFile(join(root,'profile-launcher.exe'));await writeFile(join(directory,'launcher.exe'),shim);
}
console.log(JSON.stringify({ready:true,pid:process.pid,privateFiles,profiles:['ssh-owner','ssh-peer','http-owner','http-peer']}));
let requestBusy=false;
input.on('line',async line=>{
 if(requestBusy)return;requestBusy=true;
 let request;
 try{
  request=JSON.parse(line);assert.equal(request.owner,config.owner);
  if(request.action==='startGateway'){
   assert.equal(active,undefined);
   const servers=['owner','peer'].map(label=>{const directory=join(root,'profiles','http-'+label);return{id:label,label:'Owned '+label,transport:'local',runtime:'kcoder',command:join(directory,'launcher.exe'),workspace:join(directory,'workspace')}});
   const serversFile=join(root,'http-servers.json');await writeFile(serversFile,JSON.stringify(servers));
   const profile=join(root,'gateway-config');await mkdir(profile,{recursive:true});
   const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','USERPROFILE','USERNAME','USERDOMAIN','TEMP','TMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
   env.APPDATA=join(root,'gateway-ambient/AppData/Roaming');env.LOCALAPPDATA=join(root,'gateway-ambient/AppData/Local');await mkdir(env.APPDATA,{recursive:true});await mkdir(env.LOCALAPPDATA,{recursive:true});
   Object.assign(env,{NODE_ENV:'test',KCODER_CONFIG_DIR:profile,KCODER_STUDIO_HOST:'127.0.0.1',KCODER_STUDIO_PORT:'0',KCODER_STUDIO_AUTH_TOKEN:config.gatewayToken,KCODER_STUDIO_SERVERS_FILE:serversFile,KCODER_STUDIO_SERVERS_STORE:join(root,'http-servers-store.json'),KCODER_STUDIO_WORKSPACE:join(root,'profiles/http-owner/workspace'),KCODER_STUDIO_KCODER_BIN:join(root,'payload/bin/kcoder.exe'),KCODER_STUDIO_WEB_ROOT:join(root,'payload/renderer-dist'),KCODER_STUDIO_ALLOWED_HOSTS:'127.0.0.1,localhost,::1'});
   const globalSettings=JSON.parse(await readFile(join(root,'profiles/http-peer/config/settings.json'),'utf8'));await writeFile(join(profile,'settings.json'),JSON.stringify(globalSettings));secureFile(join(profile,'settings.json'));
   const{packagedNativeWindowsComponentEnvironment}=await import('./native-component-image.mjs');
   Object.assign(env,await packagedNativeWindowsComponentEnvironment({resourcesPath:join(root,'payload'),appMetadata:{nativeWindowsComponentImage:config.nativePin},platform:'win32'}));
   process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN=join(root,'payload/bin/kcoder-process-supervisor.exe');
   const launched=spawnWindowsSupervised(config.node,[join(root,'payload/gateway/dev-server.mjs')],{cwd:join(root,'payload/gateway'),env,stdio:['pipe','pipe','pipe']},join(root,'gateway-owner'));
   active=launched.child;active.stderr.on('data',data=>process.stderr.write(data));
   let text='';const port=await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(Error('Owned Gateway ready deadline')),30000);active.stdout.on('data',data=>{text=(text+data).slice(-8192);const m=/KCoder Studio: http:\/\/[^:]+:(\d+)/.exec(text);if(m){clearTimeout(timer);accept(Number(m[1]))}});active.once('error',reject);active.once('close',()=>reject(Error('Owned Gateway exited before ready')))});
   await launched.identity.readyPromise;
   console.log(JSON.stringify({id:request.id,result:{port}}));
  }else if(request.action==='stop'){
   finished=true;active?.stdin.destroy();input.close();console.log(JSON.stringify({id:request.id,result:{stopped:true}}));
  }else throw Error('Unsupported controller action');
 }catch(error){console.log(JSON.stringify({id:request?.id,error:'Owned controller phase failed'}));process.exitCode=1;active?.stdin.destroy();input.close();}
 finally{requestBusy=false;}
});
