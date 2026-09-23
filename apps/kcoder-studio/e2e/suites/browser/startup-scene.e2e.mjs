import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from '../../../renderer/node_modules/vite/dist/node/index.js';
import react from '../../../renderer/node_modules/@vitejs/plugin-react/dist/index.js';
import { startChromium } from '../../harness/chromium.mjs';
import { runE2E, appRoot } from '../../harness/run-context.mjs';

// This component-only visual test measures layout/motion, not backend or model behavior.
await runE2E(import.meta.url, {
  testId: 'branded-startup-scene-motion', tier: 'full-integration',
  modelPolicy: 'model-independent component layout and animation', retainSuccessLogs: true,
}, async context => {
  const previousCwd = process.cwd();
  process.chdir(resolve(appRoot, 'studio'));
  context.addCleanup('restore preview working directory', () => { process.chdir(previousCwd); });
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import i18n from 'i18next'; import {initReactI18next,useTranslation} from 'react-i18next';
    import zh from '/src/i18n/locales/zh-CN/localRuntime.json';
    import en from '/src/i18n/locales/en/localRuntime.json';
    import '/src/styles/globals.css';
    import {StartupBrand,StartupIllustration,StartupWordmark,StartupSteps,StartupSignature} from '/src/features/local-runtime/StartupScene.tsx';
    import {ToolBlockItem} from '/src/components/chat/blocks/ToolBlockItem.tsx';
    await i18n.use(initReactI18next).init({lng:'zh-CN',resources:{'zh-CN':{localRuntime:zh},en:{localRuntime:en}}});
    const h=React.createElement;
    window.startupPreviewLanguage = language => i18n.changeLanguage(language);
    window.showToolMotion = async (name, status, outputStatus) => {
      toolRoot ||= createRoot(document.body.appendChild(document.createElement('section')));
      toolRoot.render(h(ToolBlockItem, {block:{id:'motion-tool',subtaskId:'motion-turn',type:'tool',toolName:name,toolInput:{path:'fixture.txt',content:'fixture'},toolOutput:outputStatus ? {status:outputStatus} : undefined,status,createdAt:Date.now()}}));
    };
    let toolRoot;
    function Preview() { const {t}=useTranslation('localRuntime'); return h('main',{className:'kcoder-startup-shell'},h(StartupBrand),h('section',{className:'kcoder-startup-content'},h(StartupIllustration),h(StartupWordmark),h('h1',{className:'kcoder-startup-heading'},t('starting_title')),h('p',{className:'kcoder-startup-description'},t('starting_description')),h(StartupSteps)),h(StartupSignature)); }
    createRoot(document.getElementById('root')).render(h(Preview));
  </script></body></html>`;
  const server = await createServer({
    root: resolve(appRoot, 'studio'), configFile: false,
    cacheDir: context.pathInState('vite-cache'),
    optimizeDeps: { entries: [], include: ['react', 'react-dom/client', 'i18next', 'react-i18next', 'lucide-react'] },
    resolve: { alias: { '@': resolve(appRoot, 'renderer/src') } },
    plugins: [react(), { name: 'owned-startup-preview', configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== '/') return next();
        try { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/', html)); }
        catch (error) { next(error); }
      });
    } }],
    server: { host: '127.0.0.1', port: 0 },
  });
  context.addCleanup('close startup preview', () => server.close());
  await server.listen();
  const port = server.httpServer.address().port;
  context.registerPort('startup-preview', port);
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1367, height: 1151 } });
  const pageErrors = [];
  page.on('pageerror', error => { if (pageErrors.length < 8) pageErrors.push(error.message); });
  context.addCleanup('close startup page', () => page.close());
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('.kcoder-startup-step').nth(2).waitFor({ timeout: 90_000 }).catch(async error => {
    await context.writeArtifactJson('startup-failure.json', { body: await page.locator('body').innerText(), html: await page.content(), pageErrors });
    await page.screenshot({ path: context.pathInArtifacts('startup-failure.png') });
    throw new Error(`${error.message}; component page errors: ${pageErrors.join('; ')}`);
  });
  assert.equal(await page.locator('.kcoder-startup-card').count(), 3);
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'), null);
  const animated = await page.locator('.kcoder-startup-card').first().evaluate(async element => {
    const before = getComputedStyle(element).transform;
    await new Promise(resolve => setTimeout(resolve, 180));
    return before !== getComputedStyle(element).transform;
  });
  assert.equal(animated, true, 'floating cards must actually animate');
  await page.locator('.kcoder-startup-card-chat').evaluate(element => Promise.all(element.getAnimations().filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished)));
  await page.screenshot({ path: resolve(context.artifactsDir, 'startup-desktop.png'), fullPage: true });
  for (const viewport of [{ width: 1420, height: 835 }, { width: 1280, height: 720 }, { width: 1024, height: 600 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const shell = document.querySelector('.kcoder-startup-shell');
      const footer = document.querySelector('.kcoder-startup-signature').getBoundingClientRect();
      const steps = document.querySelector('.kcoder-startup-steps').getBoundingClientRect();
      return { fits: shell.scrollHeight <= shell.clientHeight + 1 && document.documentElement.scrollHeight <= innerHeight + 1,
        footerVisible: footer.bottom <= innerHeight && footer.top >= 0,
        stepsVisible: steps.bottom <= innerHeight && steps.top >= 0 };
    });
    assert.deepEqual(layout, { fits: true, footerVisible: true, stepsVisible: true }, `startup must fit ${viewport.width}x${viewport.height}`);
    await page.screenshot({ path: resolve(context.artifactsDir, `startup-fit-${viewport.width}.png`) });
  }
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  const reducedMotionAnimated = await page.locator('.kcoder-startup-track span').evaluate(async element => {
    const before = getComputedStyle(element).transform;
    await new Promise(resolve => setTimeout(resolve, 200));
    return getComputedStyle(element).animationName !== 'none' && before !== getComputedStyle(element).transform;
  });
  assert.equal(reducedMotionAnimated, true, 'user-required startup motion must remain live with reduced motion');
  await page.setViewportSize({ width: 390, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(context.artifactsDir, 'startup-mobile-reduced.png'), fullPage: true });
  await page.evaluate(() => window.startupPreviewLanguage('en'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(context.artifactsDir, 'startup-mobile-en.png'), fullPage: true });
  await page.setViewportSize({width:1280,height:720});
  const toolMotion = [];
  for (const name of ['write', 'edit', 'bash', 'read', 'custom_tool', 'apply_patch',
    'CreateWorkPlan', 'EditWorkPlan', 'AppendWorkNotepad', 'RecordTaskAcceptance',
    'RecordTaskAcceptances', 'ReopenTask', 'SelectActiveWork', 'TaskCreate', 'TaskUpdate', 'TaskOutput', 'TaskStop',
    'spawn_agent', 'explore_agent', 'PlanAgent']) {
    await page.evaluate(name => window.showToolMotion(name, 'streaming'), name);
    const spinner = page.locator('body > section svg.animate-spin').first();
    await spinner.waitFor({state:'attached'});
    const moves = await spinner.evaluate(async element => {
      const before=getComputedStyle(element).transform;
      await new Promise(resolve=>setTimeout(resolve,150));
      return getComputedStyle(element).animationName !== 'none' && before !== getComputedStyle(element).transform;
    });
    assert.equal(moves,true, `${name} spinner must rotate even with reduced motion`);
    toolMotion.push(name);
    await page.evaluate(name => window.showToolMotion(name, 'done'), name);
    await page.waitForFunction(()=>!document.querySelector('body > section svg.animate-spin'));
  }
  const subagentMotion = [];
  for (const name of ['spawn_agent', 'explore_agent', 'PlanAgent']) {
    for (const status of ['queued', 'running', 'queued', 'running']) {
      await page.evaluate(({name,status}) => window.showToolMotion(name, 'done', status), {name,status});
      const row = page.locator(`[data-subagent-lifecycle="${status}"]`);
      await row.waitFor();
      const moves = await row.locator('svg.animate-spin').evaluate(async element => {
        const before = getComputedStyle(element).transform;
        await new Promise(resolve => setTimeout(resolve, 150));
        return before !== getComputedStyle(element).transform;
      });
      assert.equal(moves, true, `${name} ${status} must keep rotating after launch returns`);
    }
    for (const status of ['completed', 'failed', 'interrupted']) {
      await page.evaluate(({name,status}) => window.showToolMotion(name, 'done', status), {name,status});
      await page.locator(`[data-subagent-lifecycle="${status}"]`).waitFor();
      assert.equal(await page.locator('body > section svg.animate-spin').count(), 0);
    }
    subagentMotion.push(name);
  }
  return { cards: 3, indeterminate: true, transformChanged: animated, reducedMotionAnimated, mobileOverflow: false,
    subagentMotion,
    toolMotion,
    scope: 'component visual only; startup state machine is separately unit tested' };
});
