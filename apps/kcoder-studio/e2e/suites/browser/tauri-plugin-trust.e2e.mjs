import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

// QA: isolated local marketplace; explicit add consent, confirm-before-revoke,
// never decision and deliberate restore, persisted target profile, no model calls.
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('KCODER_E2E_TAURI_BIN is required');
const compactOnly = process.env.KCODER_E2E_PLUGIN_COMPACT_ONLY === '1';
const iconsOnly = compactOnly || process.env.KCODER_E2E_PLUGIN_ICONS_ONLY === '1';
await runE2E(import.meta.url, {
  testId: compactOnly ? 'tauri-plugin-compact-navigation' : iconsOnly ? 'tauri-plugin-theme-icon-recovery' : 'tauri-plugin-trust-management', tier: 'manual-live',
  retainSuccessEvidence: iconsOnly, evidenceReason: iconsOnly ? 'Native malformed image fallback and dark/narrow proxy controls need visual evidence' : undefined,
  modelPolicy: 'model-independent real native UI and target trust storage; no model requests',
}, async context => {
  const source = context.pathInState('trust-market');
  await mkdir(resolve(source, '.claude-plugin'), { recursive: true });
  await writeFile(resolve(source, '.claude-plugin/marketplace.json'), JSON.stringify({
    name: 'trust-native', owner: { name: 'Fixture' }, plugins: iconsOnly ? [{name:'owned-icons', source:'./icon-plugin', description:'Owned theme icon recovery.'}] : [],
  }));
  const iconRoot = resolve(source, 'icon-plugin');
  const lightSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect x="4" y="4" width="56" height="56" rx="12" fill="#eee"/><text x="32" y="44" text-anchor="middle" font-size="36" fill="#222">L</text></svg>';
  if (iconsOnly) {
    await mkdir(resolve(iconRoot,'.claude-plugin'), {recursive:true});
    await mkdir(resolve(iconRoot,'skills/owned-icons'), {recursive:true});
    await writeFile(resolve(iconRoot,'.claude-plugin/plugin.json'), JSON.stringify({name:'owned-icons', interface:{logo:'./light.svg',logoDark:'./dark.png'}, skills:['./skills/owned-icons']}));
    await writeFile(resolve(iconRoot,'skills/owned-icons/SKILL.md'), '---\nname: owned-icons\ndescription: Owned inert fixture.\n---\nFixture only.\n');
    await writeFile(resolve(iconRoot,'light.svg'),lightSvg);
    await writeFile(resolve(iconRoot,'dark.png'),'broken-image-fixture');
  }
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
    rendererRoot: resolve(appRoot, 'renderer/dist'),
  });
  const selector = id => `[data-testid="${id}"]`;
  const click = id => client.command('click', { selector: selector(id) });
  if (iconsOnly) {
    const settings = JSON.parse(await readFile(client.settingsPath, 'utf8'));
    settings.plugins ??= {}; settings.plugins.installation ??= {};
    settings.plugins.installation.auto_detect_proxy = true;
    await writeFile(client.settingsPath, JSON.stringify(settings));
  }
  const trustFile = resolve(dirname(client.settingsPath), 'trusted-folders.json');
  const trust = async () => JSON.parse(await readFile(trustFile, 'utf8'));
  try {
    if (iconsOnly) {
      await client.command('navigate', {value:'/settings/appearance'});
      await client.command('waitFor', {selector:selector('appearance-mode-dark'),visible:true});
      await click('appearance-mode-dark');
    }
    await client.command('navigate', { value: '/plugins' });
    await client.command('waitFor', { selector: selector('plugins-add-marketplace-button'), timeoutMs: 15000 });
    await waitFor(async () => (await client.command('getText', { selector: selector('plugins-install-target') })).includes('/workspaces/tauri-verification'), 15000, 'target bootstrap');
    await click('plugins-add-marketplace-button');
    await click('plugins-add-custom-marketplace-button');
    await client.command('fill', { selector: selector('plugins-marketplace-path-input'), value: source });
    await click('plugins-marketplace-trust-directory');
    await click('plugins-marketplace-save-button');
    await waitFor(async () => Number(await client.command('getElementCount', { selector: selector('plugins-marketplace-config-dialog') })) === 0, 15000, 'marketplace registered');
    assert.ok((await trust()).trusted.includes(source));
    if (compactOnly) return await verifyCompactNavigation(client);
    if (iconsOnly) {
      const row = 'plugin-marketplace-row-owned-icons@trust-native';
      const image = `${selector(row)} img`;
      const decoded = async () => {
        await waitFor(async () => {
          const [state] = JSON.parse(await client.command('getElementMetrics', {selector:image}));
          return state.imageComplete && state.naturalWidth > 0 && state.naturalHeight > 0;
        }, 15000, 'native image actually decoded');
      };
      await client.command('waitFor', {selector:selector(row),visible:true});
      await client.command('scrollIntoView', {selector:selector(row)});
      await client.command('waitFor', {selector:`${image}[src^="data:image/svg+xml"]`,visible:true,timeoutMs:15000});
      await decoded();
      await client.capture('native-plugin-light-fallback-dark.png');
      await writeFile(resolve(iconRoot,'dark.png'),await readFile(resolve(appRoot,'renderer/src-tauri/icons/32x32.png')));
      await client.command('waitFor',{selector:selector('plugins-auto-proxy-switch'),enabled:true});
      assert.equal(await client.command('getAttribute',{selector:selector('plugins-auto-proxy-switch'),value:'aria-checked'}),'true');
      await click('plugins-auto-proxy-switch');
      await waitFor(async () => JSON.parse(await readFile(client.settingsPath,'utf8')).plugins.installation.auto_detect_proxy===false,10000,'native proxy disable persisted');
      await client.command('waitFor', {selector:`${image}[src^="data:image/png"]`,visible:true,timeoutMs:15000});
      await decoded();
      await client.command('resizeWindow',{value:'400x600'});
      await client.command('scrollIntoView',{selector:selector(row)});
      await client.capture('native-plugin-recovered-narrow.png');
      await client.command('resizeWindow',{value:'1280x720'});
      await client.command('navigate',{value:'/settings/appearance'});
      await client.command('waitFor',{selector:selector('appearance-mode-light'),visible:true});
      await click('appearance-mode-light');
      await client.command('navigate',{value:'/plugins'});
      await client.command('waitFor',{selector:selector(row)});
      await client.command('scrollIntoView', {selector:selector(row)});
      await client.command('waitFor', {selector:`${image}[src^="data:image/svg+xml"]`,visible:true,timeoutMs:15000});
      return {native:true,malformedDarkFallsBack:true,proxyDisablePersisted:true,preferredIconRecovers:true,narrow:true,lightTheme:true,modelRequests:0,externalMarketplacesUsed:false};
    }
    await click('plugins-trust-manage-button');
    await client.command('waitFor', { selector: selector('plugin-trust-revoke'), timeoutMs: 15000 });
    await click('plugin-trust-revoke');
    assert.ok((await trust()).trusted.includes(source), 'confirmation has not yet changed trust');
    await click('plugin-trust-apply');
    await waitFor(async () => (await trust()).revoked_defaults?.includes(source), 15000, 'persist revoke');
    await client.command('waitFor', { selector: selector('plugin-trust-trust'), timeoutMs: 15000 });
    await click('plugin-trust-never');
    await click('plugin-trust-apply');
    await waitFor(async () => (await trust()).never.includes(source), 15000, 'persist never');
    await waitFor(async () => Number(await client.command('getElementCount', { selector: selector('plugin-trust-confirm') })) === 0, 15000, 'never response applied to UI');
    assert.match(await client.command('getText', { selector: selector('plugin-trust-manager') }), /显式设置 · 禁止信任/);
    await client.capture('trust-never.png');
    await click('plugin-trust-trust');
    await click('plugin-trust-apply');
    await waitFor(async () => (await trust()).trusted.includes(source) && !(await trust()).never.includes(source), 15000, 'explicit restore');
    await client.command('waitFor', { selector: selector('plugin-trust-revoke'), timeoutMs: 15000 });
    await context.writeArtifactJson('trust-results.json', {
      targetScoped: true, confirmationBeforeMutation: true, revokePersisted: true,
      neverPersisted: true, deliberateRestore: true, realTauri: true,
    });
  } catch (error) {
    client.markFailed();
    await client.capture('trust-failure.png').catch(() => {});
    throw error;
  } finally { await client.stop(); }
});


async function verifyCompactNavigation(client) {
  const command=(action,selector,args={})=>client.command(action,{selector,...args});
  const focused=async(selector)=>waitFor(async()=>{
    const count=Number(await command('getElementCount',selector));
    if (!count) return false;
    const [metrics]=JSON.parse(await command('getElementMetrics',selector));
    return metrics.focused;
  },10000,'navigation DOM focus');
  const collapsed=async(pageId='plugins-page')=>{
    await waitFor(async()=>{
      const [sidebar]=JSON.parse(await command('getElementMetrics',`[data-testid="${pageId}"] [data-testid="desktop-sidebar"]`));
      return sidebar.width < 2;
    },10000,'compact sidebar releases its width');
  };
  await client.command('resizeWindow',{value:'400x600'});
  await collapsed();
  const page = await waitFor(async () => {
    const [metrics] = JSON.parse(await command('getElementMetrics','[data-testid="plugins-workspace"]'));
    return metrics.width >= 390 && metrics.left < 3 ? metrics : null;
  },10000,'compact layout settles after sidebar width transition');
  const toggle='[data-testid="plugins-topbar"] [data-testid="expand-sidebar-button"]';
  await command('waitFor',toggle,{enabled:true,visible:true});
  await command('click',toggle);
  await focused('[data-testid="mobile-drawer-close"]');
  await command('press','[data-testid="mobile-drawer-close"]',{key:'Escape'});
  await focused(toggle);
  assert.equal(Number(await command('getElementCount','[data-testid="mobile-drawer"]')),0);
  await command('click','[data-testid="plugins-install-target"] summary');
  await command('waitFor','[data-testid="plugins-install-target"][open]',{text:'/workspaces/tauri-verification'});
  await command('click','[data-testid="plugins-install-target"] summary');
  await command('scrollIntoView','[data-testid="plugin-marketplace-row-owned-icons@trust-native"]');
  await client.capture('native-plugins-compact-dark.png');
  await command('click','[data-testid="plugins-compact-manage-button"]');
  await command('waitFor','[data-testid="kcoder-plugin-management"]');
  await collapsed('plugin-management-page');
  const managementToggle='[data-testid="kcoder-plugin-management"] [data-testid="expand-sidebar-button"]';
  await command('waitFor',managementToggle,{enabled:true});await command('press',managementToggle,{key:'Control+b'});
  await focused('[data-testid="mobile-drawer-close"]');
  await command('press','[data-testid="mobile-drawer-close"]',{key:'Shift+Tab'});
  await focused('[data-testid="mobile-new-chat-button"]');
  await command('press','[data-testid="mobile-new-chat-button"]',{key:'Tab'});
  await focused('[data-testid="mobile-drawer-close"]');
  await client.capture('native-plugin-navigation-compact.png');
  await command('click','[data-testid="mobile-drawer-close"]');
  await focused(managementToggle);
  await client.capture('native-plugin-management-compact-dark.png');
  await client.command('resizeWindow',{value:'1280x720'});
  await waitFor(async()=>{
    const [sidebar]=JSON.parse(await command('getElementMetrics','[data-testid="plugin-management-page"] [data-testid="desktop-sidebar"]'));
    return sidebar.width>=240;
  },10000,'wide preference restored');
  await client.command('navigate',{value:'/settings/appearance'});
  await command('waitFor','[data-testid="appearance-mode-light"]');await command('click','[data-testid="appearance-mode-light"]');
  await client.command('navigate',{value:'/plugins'});await command('waitFor','[data-testid="plugins-workspace"]');
  await client.command('resizeWindow',{value:'400x600'});await collapsed();
  await command('scrollIntoView','[data-testid="plugin-marketplace-row-owned-icons@trust-native"]');
  await client.capture('native-plugins-compact-light.png');
  return {native:true,compactContentWidth:page.width,sidebarDoesNotCrowd:true,overlayCloseAndFocusReturn:true,keyboardFocusTrap:true,managementRoute:true,widePreferenceRestored:true,targetDetails:true,lightAndDark:true,modelRequests:0};
}
