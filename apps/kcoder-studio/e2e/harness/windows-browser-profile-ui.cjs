const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');

exports.runWindowsBrowserProfileUi=async function({evaluate,until,click,screenshot,request,profile,artifacts,modelUrl,getWireTrace,setStage}){
 const label='Owned Windows browser profile';
 const exists=id=>evaluate(`Boolean(document.querySelector('[data-testid="${id}"]'))`);
 const text=id=>evaluate(`document.querySelector('[data-testid="${id}"]')?.innerText||''`);
 const accountButton=()=>evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>['浏览器账户','Browser accounts'].includes(e.getAttribute('aria-label')));if(!e)return false;e.click();return true})()`);
 const site=http.createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'text/html'});response.end('<!doctype html><title>Owned Windows profile</title><input aria-label="Owned input"><p>Independent profile fixture</p>')});
 await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${site.address().port}/`;
 const lifecycle=[];
 const note=async(phase,facts={})=>{setStage('browser-profile-'+phase);lifecycle.push({phase,at:Date.now(),...facts});assert.ok(lifecycle.length<=20);await fs.writeFile(path.join(artifacts,'windows-browser-profile-ui-lifecycle.json'),JSON.stringify({lifecycle,wire:getWireTrace().filter(row=>/browser\/|integrations\/browserProfiles\//.test(row.method||''))}));};
 try{
  await note('open-panel');
  await click('toggle-right-workspace-panel-button');await click('right-workspace-browser-option');await until(()=>exists('workspace-browser-panel'));
  await until(accountButton);await until(()=>exists('browser-account-dialog'));
  await evaluate(`document.querySelector('[data-testid="browser-account-dialog"] details summary').click()`);
  await evaluate(`(()=>{const e=document.querySelector('[data-testid="browser-account-dialog"] form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(label)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await until(()=>evaluate(`(()=>{const e=document.querySelector('[data-testid="browser-account-dialog"] form button[type=submit]');if(!e||e.disabled)return false;e.click();return true})()`));
  await until(()=>evaluate(`Boolean([...document.querySelectorAll('[data-testid="browser-account-list"] button')].find(e=>e.innerText.includes(${JSON.stringify(label)})))`));
  await evaluate(`(()=>{const e=[...document.querySelectorAll('[data-testid="browser-account-list"] button')].find(e=>e.innerText.includes(${JSON.stringify(label)}));e.click()})()`);
  await until(async()=>!await exists('browser-account-dialog'));
  await evaluate(`(()=>{const e=document.querySelector('[data-testid="workspace-browser-url-input"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(url)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.focus();return true})()`);
  await until(()=>evaluate(`document.querySelector('[data-testid="workspace-browser-url-input"]')?.value===${JSON.stringify(url)}`));
  await evaluate(`document.querySelector('[data-testid="workspace-browser-url-input"]').closest('form').requestSubmit()`);
  await until(()=>exists('kcoder-remote-browser-surface'),30000);
  await until(()=>evaluate(`document.querySelector('[data-testid="kcoder-remote-browser-surface"]')?.dataset.frameReady==='true'`),30000);
  await until(async()=>/自动化控制|Automation/.test(await text('workspace-browser-control-status')));
  await note('original-native-open');
  const catalogEntries=await fs.readdir(profile,{withFileTypes:true});assert.ok(catalogEntries.length<256);
  const candidates=[];
  for(const entry of catalogEntries){
   if(!entry.isDirectory()||entry.isSymbolicLink()||!entry.name.startsWith('integration-'))continue;
   const catalog=path.join(profile,entry.name,'catalog');
   let data;try{data=JSON.parse(await fs.readFile(path.join(catalog,'profiles.json'),'utf8'))}catch(error){if(error.code==='ENOENT')continue;throw error}
   for(const [id,value]of Object.entries(data.profiles||{}))if(value.draft.label===label)candidates.push({id,catalog,data});
  }
  assert.equal(candidates.length,1);const original=candidates[0],use=original.data.activeUses[original.id];assert.ok(use?.useId);
  const receipt=path.join(original.catalog,`cleanup-${use.useId}.receipt`);assert.equal((await fs.readFile(receipt)).length,0);
  await click('workspace-browser-handoff');await until(async()=>/你正在接管|You.*control|Human/.test(await text('workspace-browser-control-status')));
  await click('workspace-browser-handoff');await until(async()=>/自动化控制|Automation/.test(await text('workspace-browser-control-status')));
  await note('handoff-returned');
  await screenshot('windows-browser-profile-handoff.png');
  await until(accountButton);await until(()=>exists('browser-account-dialog'));
  const temporaryState=()=>evaluate(`(()=>{const d=document.querySelector('[data-testid="browser-account-dialog"]');const e=[...(d?.querySelectorAll('button')||[])].find(e=>['临时会话','Temporary session'].includes(e.innerText.trim()));return{dialogPresent:Boolean(d),temporaryPresent:Boolean(e),enabled:Boolean(e&&!e.disabled),catalogRows:d?.querySelectorAll('[data-testid="browser-account-list"] button').length||0}})()`);
  await note('catalog-pending-observed',await temporaryState());
  await until(async()=>{const state=await temporaryState();return state.dialogPresent&&state.enabled&&state.catalogRows===1;});
  await note('catalog-current-enabled',await temporaryState());
  await evaluate(`(()=>{const e=[...document.querySelectorAll('[data-testid="browser-account-dialog"] button')].find(e=>['临时会话','Temporary session'].includes(e.innerText.trim()));if(!e||e.disabled)throw Error('Original current choice is not enabled');e.click()})()`);
  await note('explicit-temporary-selected');
  await until(async()=>!await exists('browser-account-dialog'));
  await until(async()=>!await exists('workspace-browser-handoff'));
  await until(async()=>{try{return(await fs.readFile(receipt)).equals(Buffer.from('kcoder-owned-cleanup/v1\nconfirmed\n'))}catch{return false}},10000);
  const current=JSON.parse(await fs.readFile(path.join(original.catalog,'profiles.json'),'utf8'));assert.equal(current.activeUses[original.id],undefined);
  const closes=getWireTrace().filter(row=>row.direction==='sent'&&row.method==='browser/close');assert.equal(closes.length,1,'one explicit close of the original current native browser');
  await note('original-receipt-and-release-confirmed');
  await screenshot('windows-browser-profile-temporary.png');
  const metrics=await(await fetch(modelUrl.replace(/\/v1$/,'')+'/metrics')).json();assert.equal(metrics.requests.length,0);
  const metadata={passed:true,actualPackagedElectron:true,actualGatewayOuterJob:true,actualProfileUiSaveSelect:true,actualHandoffRoundTrip:true,explicitTemporarySwitch:true,originalCleanupReceiptConfirmed:true,originalUseReleased:true,userDataPathChars:path.join(original.catalog,'browser-data-'+original.id).length,providerRequests:0,modelCalls:0,websiteLogins:0,installerClaim:false,hardCrashNotYetTested:true};
  await fs.writeFile(path.join(artifacts,'windows-browser-profile-ui-observation.json'),JSON.stringify(metadata));return metadata;
 }finally{site.closeAllConnections();await new Promise(resolve=>site.close(resolve));}
};
