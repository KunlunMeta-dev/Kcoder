import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor, requireExecutable } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url,{testId:'settings-fonts-shortcut-conflicts-and-zoom',tier:'full-integration',modelPolicy:'model-independent actual settings persistence, keyboard recording and optional Electron menu zoom'},async context=>{
 const {path:workspace}=await materializeWorkspace(context,'minimal');
 const native=process.env.KCODER_E2E_SETTINGS_ELECTRON==='1';
 let browser,page,base;
 if(native){
  if(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX!=='1')throw Error('Explicit owned Chromium no-sandbox opt-in required');
  const electron=await requireExecutable(resolve(appRoot,'node_modules/electron/dist/electron'),'Electron');
  const binary=await requireExecutable(resolve(repoRoot,'target/debug/kcoder'),'KCoder');
  await context.writeStateJson('profile/settings.json',{providers:{}});
  const servers=await context.writeStateJson('servers.json',[{id:'local',label:'Settings fixture',transport:'local',command:binary,workspace}]);
  let output='';const child=context.spawnOwned('electron-settings','/usr/bin/xvfb-run',['-a','-s','-screen 0 1440x1000x24 -nolisten tcp','/bin/sh','-c','printf %s "$DISPLAY" > "$1"\nprintf %s "$XAUTHORITY" > "$2"\nshift 2\nexec "$@"','owned-display',context.pathInState('display'),context.pathInState('xauthority'),electron,'--no-sandbox','--disable-gpu','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',resolve(appRoot,'desktop/main.mjs')],{cwd:appRoot,env:context.isolatedEnvironment({KCODER_STUDIO_TEST_WINDOWS_MENU:'1',KCODER_CONFIG_DIR:context.pathInState('profile'),KCODER_STUDIO_SERVERS_FILE:servers,KCODER_STUDIO_KCODER_BIN:binary,KCODER_STUDIO_WORKSPACE:workspace,KCODER_STUDIO_DESKTOP_USER_DATA_DIR:context.pathInState('electron-profile'),KCODER_STUDIO_WEB_ROOT:resolve(appRoot,'renderer/dist')})});
  const collect=chunk=>{output=(output+chunk).slice(-16000)};child.stdout.on('data',collect);child.stderr.on('data',collect);
  const cdp=await waitFor(()=>output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1],30000,'owned Electron CDP');
  context.registerPort('electron-settings-cdp',Number(new URL(cdp).port));browser=await chromium.connectOverCDP(cdp);context.addCleanup('close settings CDP',()=>browser.close());
  page=await waitFor(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://127.0.0.1:')),30000,'owned Electron settings page');base=new URL(page.url()).origin;
 }else{await context.writeStateJson('kcoder-home/settings.json',{providers:{}});const gateway=await startGateway(context,{workspace});browser=await startChromium(context);page=await browser.newPage({viewport:{width:1280,height:900}});base=gateway.baseUrl;}
 const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
 let captureSequence=0;
 const capture=async name=>{
  if(!native)return page.screenshot({path:context.pathInArtifacts(name)});
  const display=(await readFile(context.pathInState('display'),'utf8')).trim();
  assert.match(display,/^:\d+$/);
  const authority=(await readFile(context.pathInState('xauthority'),'utf8')).trim();
  const capture=context.spawnOwned(`owned-display-capture-${++captureSequence}`,'/usr/bin/import',['-display',display,'-window','root',context.pathInArtifacts(name)],{env:context.isolatedEnvironment({DISPLAY:display,XAUTHORITY:authority})});
  await new Promise((resolve,reject)=>{capture.once('error',reject);capture.once('exit',code=>code===0?resolve():reject(Error('Owned display capture failed')))});
 };
 const open=async path=>native?page.evaluate(path=>{history.pushState(null,'',path);window.dispatchEvent(new PopStateEvent('popstate'))},path):page.goto(`${base}${path}`,{waitUntil:'domcontentloaded'});
 try{
  if(native)await page.getByTestId('desktop-sidebar').waitFor({timeout:60000});
  await open('/settings');await page.getByTestId('general-language-en-button').click();
  await page.getByTestId('settings-nav-appearance').click();
  const ui=page.getByTestId('appearance-ui-font-size-input'),code=page.getByTestId('appearance-code-font-size-input');
  await ui.fill('16');await ui.press('Tab');await expect(code).toHaveValue('12');
  await code.fill('22');await code.press('Tab');await expect(ui).toHaveValue('16');
  await page.getByTestId('appearance-ui-font-input').selectOption({label:'Arial'});
  await page.getByTestId('appearance-code-font-input').selectOption({label:'Liberation Mono'});
  if(!native)await page.reload({waitUntil:'domcontentloaded'});await ui.waitFor({timeout:60000});await expect(ui).toHaveValue('16');await expect(code).toHaveValue('22');
  assert.match(await page.getByTestId('appearance-ui-font-input').inputValue(),/Arial/);
  assert.match(await page.getByTestId('appearance-code-font-input').inputValue(),/Liberation Mono/);
  await page.getByTestId('settings-nav-keyboard-shortcuts').click();
  const record=page.getByTestId('keyboard-shortcut-record-openTerminal');
  await expect(record).toBeEnabled();await record.focus();await page.keyboard.press('Enter');await page.keyboard.press('Control+b');
  await expect(page.getByRole('alert')).toContainText('already assigned');
  await page.keyboard.press('Escape');await expect(record).toBeFocused();
  await record.press('Enter');await page.keyboard.press('Control+Alt+k');await expect(page.getByRole('status')).toContainText('saved');
  await expect(record).toContainText('Ctrl Alt K');if(!native)await page.reload({waitUntil:'domcontentloaded'});await record.waitFor({timeout:60000});await expect(record).toContainText('Ctrl Alt K');
  await page.getByTestId('keyboard-shortcut-clear-openTerminal').click();await expect(record).toContainText('Unassigned');
  await page.getByTestId('keyboard-shortcut-reset-openTerminal').click();await expect(record).toContainText('Ctrl J');
  let zoom=1;
  if(native){
   const initial=await page.evaluate(()=>devicePixelRatio);
   for(let attempt=0;attempt<8&&zoom<1.99;attempt++){
    await page.evaluate(async()=>{const menus=await window.kcoderDesktopMenu.list('en');for(const menu of menus){const item=menu.entries?.find(item=>item.id==='zoomIn');if(item){await window.kcoderDesktopMenu.invoke(menu.index,item.position);return}}throw Error('Zoom menu absent')});
    await page.waitForTimeout(100);zoom=await page.evaluate(()=>devicePixelRatio)/initial;
   }
   assert.ok(zoom>=1.99&&zoom<=2.1,'actual Electron 200% zoom');
  }else await page.setViewportSize({width:400,height:600});
  await record.scrollIntoViewIfNeeded();await record.click();await page.keyboard.press('Escape');await expect(record).toBeFocused();
  await record.scrollIntoViewIfNeeded();
  const visible=await record.evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}});
  assert.ok(visible.left>=0&&visible.right<=visible.width+1&&visible.top>=0&&visible.bottom<=visible.height+1,JSON.stringify(visible));
  const bounds=await page.getByTestId('keyboard-shortcuts-settings-page').evaluate(e=>({scroll:e.scrollWidth,width:e.clientWidth,viewport:innerWidth}));
  assert.ok(bounds.scroll<=bounds.width+1,'shortcut page must fit without clipping actions');
  await capture(native?'electron-200-percent-shortcuts.png':'browser-narrow-shortcuts.png');
  if(await page.getByTestId('settings-compact-select').isVisible())await page.getByTestId('settings-compact-select').selectOption('appearance');
  else await page.getByTestId('settings-nav-appearance').click();
  await page.getByTestId('appearance-mode-dark').click();
  await page.getByTestId('appearance-reset-button').click();await expect(ui).toHaveValue('14');await expect(code).toHaveValue('12');
  await page.getByTestId('appearance-code-font-input').scrollIntoViewIfNeeded();
  await capture(native?'electron-200-percent-fonts.png':'browser-narrow-fonts.png');
  return {native,zoom,fontsIndependent:true,fontsPersisted:!native,conflictRejected:true,keyboardSaved:true,resetAndClear:true,narrowActionsReachable:true};
 }catch(error){await context.writeArtifactJson('page-errors.json',pageErrors);await page.screenshot({path:context.pathInArtifacts('failure.png')}).catch(()=>{});throw error;}
 finally{if(!native)await page.close();}
});
