import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {runE2E,appRoot} from '../../harness/run-context.mjs';
import {startChromium} from '../../harness/chromium.mjs';
const require=createRequire(new URL('../../../renderer/package.json',import.meta.url));
const {build}=require('vite');
const react=(await import(require.resolve('@vitejs/plugin-react'))).default;
const tailwind=require('tailwindcss'),autoprefixer=require('autoprefixer');
await runE2E(import.meta.url,{testId:'browser-account-layout',tier:'component-layout',modelPolicy:'model-independent layout and explicit-selection fixture only',retainSuccessEvidence:true,evidenceReason:'User-requested new page screenshots; no native or login claims'},async context=>{
 const renderer=join(appRoot,'renderer');
 const previous=process.cwd();process.chdir(renderer);context.addCleanup('restore account layout cwd',()=>process.chdir(previous));
 const result=await build({configFile:false,root:renderer,mode:'e2e',logLevel:'error',base:'/',plugins:[react()],
   define:{'process.env.NODE_ENV':JSON.stringify('production'),__KCODER_STUDIO_APP_VERSION__:JSON.stringify('1.0.0')},
   css:{postcss:{plugins:[tailwind({config:join(renderer,'tailwind.config.js')}),autoprefixer()]}},
   resolve:{alias:{'@':join(renderer,'src'),'@electron-apps/api/core':join(appRoot,'e2e/fixtures/browser-accounts/ipc.ts')},dedupe:['react','react-dom','i18next','react-i18next']},
   build:{write:false,minify:false,cssCodeSplit:false,target:'esnext',lib:{entry:join(appRoot,'e2e/fixtures/browser-accounts/entry.tsx'),name:'BrowserAccountLayout',formats:['es']}}});
 const outputs=(Array.isArray(result)?result[0]:result).output;
 const entry=outputs.find(value=>value.type==='chunk'&&value.isEntry),styles=outputs.filter(value=>value.type==='asset'&&value.fileName.endsWith('.css'));
 assert.ok(entry&&styles.length);
 const files=new Map(outputs.map(value=>['/'+value.fileName,value.type==='chunk'?value.code:value.source]));
 const server=http.createServer((request,response)=>{
  const pathname=new URL(request.url,'http://fixture.invalid').pathname;
  if(pathname==='/'){response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+styles.map(value=>'<link rel="stylesheet" href="/'+value.fileName+'">').join('')+'</head><body><div id="root"></div><script type="module" src="/'+entry.fileName+'"></script></body></html>');return;}
  if(files.has(pathname)){response.setHeader('Content-Type',pathname.endsWith('.css')?'text/css':'text/javascript');response.end(files.get(pathname));return;}
  response.statusCode=404;response.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));context.registerPort('browser-account-layout',server.address().port);
 context.addCleanup('close account layout HTTP',()=>new Promise(resolve=>server.close(resolve)));
 const browser=await startChromium(context);const page=await browser.newPage({viewport:{width:1280,height:900}});
 context.addCleanup('close account layout page',()=>page.close());const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.getByRole('button',{name:'浏览器账户',exact:true}).click();
 await page.getByTestId('browser-account-dialog').waitFor();assert.equal(await page.getByTestId('browser-account-list').getByRole('button').count(),10);
 assert.equal(await page.getByTestId('browser-account-dialog').evaluate(node=>getComputedStyle(node.parentElement).position),'fixed');
 assert.equal(await page.getByTestId('browser-account-dialog').evaluate(node=>getComputedStyle(node).borderTopStyle),'solid');
 await page.screenshot({path:context.pathInArtifacts('browser-accounts-wide.png')});
 await page.getByRole('button',{name:'下一页账户'}).click();assert.equal(await page.getByTestId('browser-account-list').getByRole('button').count(),1);
 await page.setViewportSize({width:390,height:844});await page.getByText('添加浏览器账户',{exact:true}).click();
 await page.getByLabel('名称',{exact:true}).fill('财务报表核对');
 await page.getByLabel('账户标签（可选）').fill('财务业务专用');
 await page.screenshot({path:context.pathInArtifacts('browser-accounts-narrow.png')});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 await page.getByRole('button',{name:'保存账户',exact:true}).click();
 const created=page.getByTestId('browser-account-list').getByRole('button').filter({hasText:'财务报表核对'});
 try { await created.waitFor({timeout:10000}); } catch(error) { await context.writeArtifactJson('account-save-failure.json',{text:await page.locator('body').innerText(),errors});throw error; }
 assert.equal(await page.getByTestId('selected-account').innerText(),'临时会话','saving metadata must not select or launch');
 await created.click();
 assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.getByTestId('selected-account').innerText(),'财务报表核对');
 assert.deepEqual(errors,[]);
 await context.writeArtifactJson('browser-account-layout-evidence.json',{fixtureOnly:true,modelCalls:0,nativeCalls:0,websiteLogins:0,tenPlusOnePaging:true,saveDoesNotLaunch:true,explicitSelection:true,narrowOverflow:false});
 return{passed:true,scope:'component layout only',screenshots:2};
});
