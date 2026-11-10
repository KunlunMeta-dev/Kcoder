import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runE2E,appRoot } from '../harness/run-context.mjs';
import { startChromium } from '../harness/chromium.mjs';
process.umask(0o077);
const taskCapabilityScope=process.argv.includes('--task-sources');
const channelCards=process.argv.includes('--channel-cards');
const require=createRequire(new URL('../../renderer/package.json',import.meta.url));
const {build}=require('vite');
const react=(await import(require.resolve('@vitejs/plugin-react'))).default;
const tailwind=require('tailwindcss'),autoprefixer=require('autoprefixer');

await runE2E(import.meta.url,{testId:taskCapabilityScope?'connectivity-task-capability-scope-layout-preview':'connectivity-layout-preview',tier:'manual-live',modelPolicy:'model-independent real React component layout fixture; no Native/platform/model calls',retainSuccessEvidence:true,evidenceReason:'User-requested new application/channel page layout preview screenshots'},async context=>{
  const renderer=path.join(appRoot,'renderer');
  process.chdir(renderer);
  const result=await build({configFile:false,root:renderer,mode:'e2e',logLevel:'error',base:'/',plugins:[react()],define:{'process.env.NODE_ENV':JSON.stringify('production')},css:{postcss:{plugins:[tailwind({config:path.join(renderer,'tailwind.config.js')}),autoprefixer()]}},resolve:{alias:{'@':path.join(renderer,'src')},dedupe:['react','react-dom','i18next','react-i18next']},build:{write:false,minify:false,cssCodeSplit:false,target:'esnext',lib:{entry:path.join(appRoot,'e2e/fixtures/connectivity-layout-preview/entry.tsx'),name:'ConnectivityLayoutPreview',formats:['es']}}});
  const outputs=(Array.isArray(result)?result[0]:result).output;
  const script=outputs.find(item=>item.type==='chunk'&&item.isEntry),styles=outputs.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css'));
  assert.ok(script&&styles.length);
  const files=new Map(outputs.map(item=>['/'+item.fileName,item.type==='chunk'?item.code:item.source]));
  const server=http.createServer((request,response)=>{
    const pathname=new URL(request.url,'http://fixture.invalid').pathname;
    if(pathname==='/'){response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'+styles.map(item=>'<link rel="stylesheet" href="/'+item.fileName+'">').join('')+'</head><body><div id="root"></div><script type="module" src="/'+script.fileName+'"></script></body></html>');return;}
    if(files.has(pathname)){response.setHeader('Content-Type',pathname.endsWith('.css')?'text/css; charset=utf-8':pathname.endsWith('.svg')?'image/svg+xml':'text/javascript; charset=utf-8');response.end(files.get(pathname));return;}
    response.statusCode=404;response.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  context.registerPort('connectivity-layout-http',server.address().port);context.addCleanup('connectivity layout HTTP',()=>new Promise(resolve=>server.close(resolve)));
  const chrome=await startChromium(context,{label:'connectivity-layout-chromium',profileName:'connectivity-layout-preview',portLabel:'connectivity-layout-cdp'});
  try{
    const page=await chrome.newPage({viewport:{width:1280,height:820}});const errors=[];page.on('pageerror',error=>{errors.push(error.message);void context.writeArtifactJson('browser-errors.json',errors).catch(()=>{});});
    if(channelCards){
      await page.goto(origin+'/?channel-cards');
      for(const platform of ['feishu','qq','weixin','wecom'])await page.getByTestId(`channel-add-connection-${platform}`).waitFor({timeout:10000});
      await page.screenshot({path:context.pathInArtifacts('channel-cards-desktop.png'),fullPage:true});
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
      await page.screenshot({path:context.pathInArtifacts('channel-cards-mobile.png'),fullPage:true});
      assert.deepEqual(errors,[]);
      await context.writeArtifactJson('channel-cards-boundary.json',{actualComponent:'ChannelConnectionsWorkspace',fixture:true,platformConnected:false,modelCalls:0,mutations:0});
      return {channelCards:true,screenshots:2,platformConnected:false};
    }
    if(taskCapabilityScope){
      await page.goto(origin+'/?task-sources');
      await page.getByRole('heading',{name:'任务来源',exact:true}).waitFor({timeout:10000});
      await page.getByRole('button',{name:/季度资料整理/}).waitFor();
      await page.screenshot({path:context.pathInArtifacts('task-capability-scope-bindings-desktop.png'),fullPage:true});
      await page.getByRole('button',{name:/季度资料整理/}).click();
      await page.getByRole('heading',{name:'本任务使用的连接器与账户'}).waitFor();
      await page.screenshot({path:context.pathInArtifacts('task-capability-scope-binding-read-desktop.png'),fullPage:true});
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
      await page.screenshot({path:context.pathInArtifacts('task-capability-scope-bindings-mobile.png'),fullPage:true});
      assert.deepEqual(errors,[]);
      await context.writeArtifactJson('task-source-preview-boundary.json',{actualComponents:['TaskCapabilityScopeSelector','TaskCapabilityScopePicker'],fixture:true,nativeMutations:0,platformConnected:false,modelCalls:0,screenshots:3});
      return {taskCapabilityScopePreview:true,screenshots:3,platformConnected:false};
    }
    await page.goto(origin);for(const platform of ['feishu','dingtalk','qq','weixin','wecom'])await page.getByTestId(`channel-add-connection-${platform}`).waitFor({timeout:10000});
    await page.screenshot({path:context.pathInArtifacts('connectivity-channels-layout-preview.png'),fullPage:true});
    assert.deepEqual(errors,[]);await context.writeArtifactJson('layout-preview-boundary.json',{actualComponent:'ChannelConnectionsWorkspace',fixture:true,platformConnected:false,modelCalls:0,mutations:0,screenshots:['connectivity-channels-layout-preview.png']});
    return {layoutPreview:true,screenshots:1,platformConnected:false};
  }finally{await chrome.close();}
});
