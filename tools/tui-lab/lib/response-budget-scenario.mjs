import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRunContext, verifyRunContextIntegrity } from './run-context.mjs';
import { browserLaunchOptions, defaultCommandString } from './runner-options.mjs';
import { runBrowserScenarioLifecycle, settleLifecycleStep } from './browser-lifecycle.mjs';
import { captureFailurePageEvidence, writeFailureArtifact } from './failure-artifact.mjs';

// Measures the real PTY -> xterm presentation, not model response latency.
export async function runResponseBudgetScenario(options, runtime) {
  const artifacts = await createRunContext(options, 'response-budget', runtime.runContextRuntime());
  const runOptions = { ...options, runDir: artifacts.dir, workspaceDir: artifacts.workspace,
    configHome: artifacts.configHome, requestsDir: artifacts.requestsDir };
  const command = defaultCommandString(runOptions);
  let session, browser, page;
  const checks = [], trace = [], browserConsole = [];
  const sampleCount = Number(process.env.KCODER_TUI_LAB_RESPONSE_SAMPLES || 12);
  if (!Number.isInteger(sampleCount) || sampleCount < 12 || sampleCount > 100) throw Error('response samples must be 12..100');
  const singleKey = process.env.KCODER_TUI_LAB_RESPONSE_SINGLE_KEY === '1';
  const metrics = { samples: [], phases: [], renderer: null, sampleCount, inputMode: singleKey ? 'single-key-after-visible-clear' : 'overlapping-multi-character-burst' };
  const check = (name, ok) => { checks.push({name,ok:!!ok}); if(!ok) throw Error(name); };
  const json = (name, data) => writeFile(path.join(artifacts.dir,name),JSON.stringify(data,null,2)+'\n');
  const visible = () => page.evaluate(() => window.tuiLab.visibleText());
  const wait = text => page.waitForFunction(text=>window.tuiLab?.visibleText().includes(text),text,{timeout:options.timeoutMs});
  const input = text => page.evaluate(text=>window.tuiLab.sendInput(text),text);
  const sample = async phase => {
    for(let i=0;i<sampleCount;i++) {
      // Unique token avoids accidentally measuring an earlier transcript echo.
      const token=singleKey ? 'x' : `p1_${phase}_${i}`;
      const ms=await page.evaluate(async ({token,singleKey})=>{
        const shown = () => singleKey
          ? (window.tuiLab.visibleText().split('\n').findLast(line=>line.trimStart().startsWith('›')) || '').includes(token)
          : window.tuiLab.visibleText().includes(token);
        const readyDeadline=performance.now()+2000;
        while(singleKey && shown()) {
          if(performance.now()>readyDeadline)throw Error('previous composer clear was not presented');
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }
        window.tuiLab.beginResponseProbe(token);
        const start=performance.now();window.tuiLab.sendInput(token);
        while(!shown()) {
          if(performance.now()-start>2000)throw Error('input feedback timeout');
          await new Promise(resolve=>requestAnimationFrame(resolve));
        }
        return { ms: performance.now()-start, ...window.tuiLab.responseProbe() };
      },{token,singleKey});
      metrics.samples.push({phase,...ms});
      await input('\u0015'); // Ctrl-U clears only the owned unsent composer.
      await page.waitForTimeout(30);
    }
  };
  const resource = async()=> {
    if(process.platform!=='linux')return null;
    // Owned PTY PID only. Linux ticks are reported raw, never assumed to be ms.
    const pid=session.ptyProcess.pid;
    const [stat,status]=await Promise.all([readFile(`/proc/${pid}/stat`,'utf8'),readFile(`/proc/${pid}/status`,'utf8')]);
    const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
    return {pid,userTicks:Number(fields[11]),systemTicks:Number(fields[12]),peakRssKiB:Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1]||0)};
  };
  await runtime.writeStartMeta(artifacts,runOptions,command,'response-budget');
  return runBrowserScenarioLifecycle({
    execute:async()=>{
      session=await runtime.startSession(runOptions);
      browser=await chromium.launch(browserLaunchOptions(options));
      page=await browser.newPage({viewport:{width:options.cols*9+16,height:options.rows*18+16}});
      await page.goto(session.url);await wait('TUI dev mode is running mock scenario');
      await page.evaluate(({cols,rows})=>window.tuiLab.resize(cols,rows),options);await page.waitForTimeout(100);
      metrics.renderer=await page.evaluate(()=>window.tuiLab.renderer);
      check('webgl-renderer',metrics.renderer==='webgl');
      metrics.dimensions=await page.evaluate(()=>window.tuiLab.dimensions());
      metrics.before=await resource();
      await sample('idle');
      await input('/permission ask\r');await wait('Permission mode set to: Ask');
      await input('P1 deterministic flood 中文🙂\r');
      await wait('Yes, and allow for this session');
      await page.screenshot({path:path.join(artifacts.dir,'approval.png')});
      await input('y');
      await page.waitForTimeout(150);
      await sample('streaming');
      await wait('tui-lab-final-sentinel');
      check('approval-and-final-delivered', (await visible()).includes('tui-lab-final-sentinel'));
      await page.waitForFunction(()=>!window.tuiLab.visibleText().includes('esc interrupt'),null,{timeout:options.timeoutMs});
      await sample('history');
      await page.keyboard.press('Home');
      await page.keyboard.press('PageUp');await page.waitForTimeout(100);
      await page.screenshot({path:path.join(artifacts.dir,'review.png')});
      await page.keyboard.press('End');
      await input('\u001b[1;5F'); // Ctrl-End: return to transcript bottom.
      await page.waitForTimeout(150);
      for(const size of [{cols:80,rows:24},{cols:160,rows:48},{cols:options.cols,rows:options.rows}]) {
        await page.evaluate(size=>window.tuiLab.resize(size.cols,size.rows),size);
        await page.waitForTimeout(120);await input('\u001b[1;5F');await page.waitForTimeout(120);
        check(`resize-tail-${size.cols}`, (await visible()).includes('tui-lab-final-sentinel'));
      }
      await input('P1 cancel this owned turn\r');
      await wait('esc interrupt');
      check('second-turn-active', !(await visible()).includes('tui-lab-second-turn-sentinel'));
      await input('\u001b');
      await wait('Cancelled.');
      await page.waitForTimeout(300);
      check('cancel-terminal-without-completion', !(await visible()).includes('tui-lab-second-turn-sentinel'));
      await sample('after-cancel');
      check('input-after-esc',metrics.samples.filter(s=>s.phase==='after-cancel').length===sampleCount);
      metrics.after=await resource();
      metrics.outputBytes=Buffer.byteLength(session.getPtyLog());
      for(const phase of ['idle','streaming','history','after-cancel']){
        const sorted=metrics.samples.filter(s=>s.phase===phase).map(s=>s.ms).sort((a,b)=>a-b);
        metrics.phases.push({phase,n:sorted.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.ceil(sorted.length*.95)-1]});
      }
      await page.screenshot({path:path.join(artifacts.dir,'final.png')});
      return await visible();
    },
    captureBeforeCleanup:()=>captureFailurePageEvidence({page,timeoutMs:1000}),
    cleanup:async()=>{
      const steps=[];
      if(browser)steps.push(await settleLifecycleStep('browser',()=>browser.close(),5000));
      if(session){steps.push(await settleLifecycleStep('session',()=>session.stop(),5000));const exit=await settleLifecycleStep('pty-exit',()=>session.exitPromise,1000);return {steps,ptyExitObserved:exit.status==='completed',ptyExit:exit.value??null};}
      return {steps,ptyExitObserved:true,ptyExit:null};
    },
    onFailure:(error,pageEvidence)=>writeFailureArtifact({artifacts,runOptions,command,mode:'response-budget',session,page,browserConsole,trace,error,repoRoot:runtime.repoRoot,pageEvidence}),
    onSuccess:async(text,cleanup)=>{
      await verifyRunContextIntegrity(artifacts,runtime.runContextRuntime());
      await Promise.all([writeFile(artifacts.text,text),writeFile(artifacts.ptyLog,session.getPtyLog()),json('metrics.json',metrics),json('assertions.json',{ok:true,checks}),json('meta.json',{ok:true,command,cleanup,metrics})]);
      console.log(JSON.stringify({ok:true,runDir:artifacts.dir,metrics},null,2));
    },
  });
}
