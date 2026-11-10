import { app, BrowserWindow, ipcMain } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeWidgetIsolationController, configureWidgetProcessIsolation } from '../../../desktop/widget-isolation/controller.mjs';

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const profile = arg('owned-profile'), reportFile = arg('owned-report'), fixtureUrl = arg('fixture-url');
if (process.platform !== 'win32' || !profile || !path.isAbsolute(profile) || !reportFile || !path.isAbsolute(reportFile) || !fixtureUrl) throw new Error('Explicit owned Windows native joint prerequisites required');
const url = new URL(fixtureUrl);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/e2e/fixtures/mcp-app-joint.html') throw new Error('Only the owned loopback MCP joint fixture is accepted');
app.setPath('userData', profile); app.setPath('sessionData', path.join(profile, 'session'));
app.on('window-all-closed', () => {}); configureWidgetProcessIsolation(app);
app.commandLine.appendSwitch('disable-background-timer-throttling'); app.commandLine.appendSwitch('disable-renderer-backgrounding');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const root = path.dirname(fileURLToPath(import.meta.url));
const report = { platform: process.platform, electron: process.versions.electron, chromium: process.versions.chrome, actualProductionController: true, actualProductionPreload: true, noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'), failure: null };
let window, controller, finishing = false;
const watchdog = setTimeout(() => { report.failure = 'Native MCP joint deadline exceeded'; void finish(1); }, 120000);
async function until(predicate, label, timeout = 20000) { const started = Date.now(); while (Date.now() - started < timeout) { const result = await predicate(); if (result) return result; await delay(60); } throw new Error(`${label} timed out`); }
const evaluate = source => window.webContents.executeJavaScript(source);
async function backend(route, body) { const response = await fetch(`${url.origin}/__mcp_joint/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-kcoder-joint': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); return result; }
async function clickApproval(index) { await until(() => evaluate('Boolean(document.querySelector("[data-testid=joint-approval]"))'), 'ordinary permission card'); report.permissionCardVisible = true; await evaluate(`document.querySelector('[data-testid="joint-approval"]').querySelectorAll('[data-testid^="request-user-input-option-"]')[${index}].click()`); }
async function appFrame() { return until(async () => {
  for(const frame of window.webContents.mainFrame.frames.filter(value=>value.url===`${url.origin}/api/widgets/isolated-v1.html`)) {
    const initialized=await frame.executeJavaScript('document.getElementById("initialized")?.textContent.startsWith("initialized:")').catch(()=>false);
    if(initialized)return frame;
  }
  return false;
}, 'actual native App frame'); }
async function finish(code) {
  if (finishing) return; finishing = true; clearTimeout(watchdog);
  controller?.dispose(); report.allOwnedLeasesReleased = controller?.activeCount() === 0; window?.destroy();
  await mkdir(path.dirname(reportFile), { recursive: true }); await writeFile(reportFile, JSON.stringify(report, null, 2));
  if (code === 0) await backend('finish', { nativeReport: report });
  app.exit(code);
}
async function run(){try {
  report.stage="reading-native-inputs";
  const inputs = [];
  for (const file of ['desktop/widget-isolation/controller.mjs', 'desktop/widget-isolation/policy.mjs', 'desktop/menu-preload.cjs', 'renderer/public/widget-sandbox/isolated-v1.html', 'renderer/public/widget-sandbox/isolated-policy-v1.json']) { const contents = await readFile(path.resolve(root, '../../..', file)); inputs.push({ file, sha256: createHash('sha256').update(contents).digest('hex') }); }
  report.nativeInputs = inputs;
  await backend('native-start',{platform:process.platform});
  report.stage="awaiting-app-ready";
  await app.whenReady();
  report.stage="creating-owned-window";
  window = new BrowserWindow({ width: 1300, height: 940, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false, partition: `mcp-joint-${process.pid}`, preload: path.resolve(root, '../../../desktop/menu-preload.cjs') } });
  controller = createNativeWidgetIsolationController({ app, ipcMain, getWindow: contents => contents === window.webContents ? window : undefined, getGatewayOrigin: () => url.origin, verifiedPlatforms: ['win32'] });
  report.stage="setting-private-session-direct-proxy";
  await window.webContents.session.setProxy({mode:"direct"});
  report.stage="loading-owned-react-fixture";
  await Promise.race([window.loadURL(fixtureUrl),delay(20000).then(()=>{throw new Error("Owned React fixture load timed out")})]);
  report.stage="reading-production-native-capability";
  report.capability = await evaluate('kcoderDesktopHost.widgets.getCapabilities()');
  if (!report.capability.isolatedHtml || report.noSandboxSwitch) throw new Error('Actual native Windows sandbox capability is required');
  report.stage="awaiting-react-controls";
  await until(() => evaluate('Boolean(document.querySelector("[data-testid=joint-begin]"))'), 'actual React fixture');
  report.stage="real-model-initial-approval";
  await evaluate('document.querySelector("[data-testid=joint-begin]").click()'); await clickApproval(0);
  report.stage="real-native-mcp-initialize";
  let frame = await appFrame();
  await until(() => frame.executeJavaScript('document.getElementById("initialized")?.textContent.includes("serverTools") && document.getElementById("input")?.textContent.includes("7") && document.getElementById("meta")?.textContent.includes("owned-real-mcp")'), 'original input, result metadata and MCP initialized');
  report.originalInputAndMeta = true;
  report.processIds = { parent: window.webContents.getOSProcessId(), app: frame.osProcessId };
  if (report.processIds.parent === report.processIds.app) throw new Error('App process must differ from the actual React parent');
  report.childHasNoNativeApi = await frame.executeJavaScript('typeof kcoderDesktopHost === "undefined" && typeof require === "undefined" && typeof process === "undefined"');
  report.parentDomBlocked = await frame.executeJavaScript('(()=>{try{parent.document.body.innerHTML;return false}catch{return true}})()');
  report.stage="real-resource-chunks";
  await frame.executeJavaScript('document.getElementById("resource").click()');
  await until(() => frame.executeJavaScript('document.getElementById("resource-result")?.textContent.startsWith("REAL_MCP_RESOURCE:")'), 'original bounded MCP resource'); report.resourceRead = true;
  report.stage="real-declined-operation";
  await frame.executeJavaScript('document.getElementById("refresh").click()'); await clickApproval(1);
  await until(async () => (await backend('snapshot')).rpcObservations.some(value => value.status === 'denied'), 'declined authoritative operation');
  report.declineVerified = (await backend('snapshot')).refreshCalls === 0;
  await until(() => evaluate('!document.querySelector("[data-testid=joint-approval]")'), 'declined card resolved');
  await frame.executeJavaScript('document.getElementById("refresh").click()');
  report.stage="real-accepted-operation-and-hook";
  const acceptedAt = Date.now();
  while (Date.now() - acceptedAt < 25000) {
    if (await evaluate('Boolean(document.querySelector("[data-testid=joint-approval]"))')) await clickApproval(0);
    const snapshot = await backend('snapshot');
    if (snapshot.refreshCalls === 1 && snapshot.hookCalls === 1 && snapshot.rpcObservations.some(value => value.status === 'completed')) break;
    await delay(100);
  }
  let snapshot = await backend('snapshot');
  if (snapshot.refreshCalls !== 1 || snapshot.hookCalls !== 1) throw new Error('Accepted action must execute through Hook exactly once');
  report.acceptVerified = true;
  await until(() => frame.executeJavaScript('!document.getElementById("repeat").disabled'), 'authoritative action result delivered');
  await frame.executeJavaScript('document.getElementById("repeat").click()'); await delay(300);
  snapshot = await backend('snapshot'); if (snapshot.refreshCalls !== 1 || snapshot.hookCalls !== 1) throw new Error('Repeated same-frame request replayed the side effect'); report.ledgerExactlyOnce = true;
  if (snapshot.rpcObservations.filter(value => value.method === 'mcp/apps/resourceContentRead').length < 3) throw new Error('Real resource did not use bounded chunk RPCs');
  await until(() => evaluate('JSON.parse(document.querySelector("[data-testid=joint-message-statuses]").textContent).every(value=>value.status!=="streaming")'), 'all real main/App approval rows settled'); report.approvalRowsSettled = true;
  report.widgetSha256 = snapshot.widget.sha256;
  report.stage="real-owner-detach-and-history";
  await evaluate('document.querySelector("[data-testid=joint-history]").click()');
  await until(() => evaluate('document.querySelector("[data-testid=joint-history-state]")?.textContent==="readonly-history"'), 'real shared-backend owner detached and resumed');
  frame = await appFrame();
  await until(() => frame.executeJavaScript('document.getElementById("initialized")?.textContent.startsWith("initialized:") && document.getElementById("refresh")?.disabled'), 'history no execution capability');
  const current = await backend('snapshot'); report.sameBackendProcess = current.sameBackendProcess;
  const denied = await fetch(`${url.origin}/__mcp_joint/rpc`, { method: 'POST', headers: { 'x-kcoder-joint': '1', 'content-type': 'application/json' }, body: JSON.stringify({ method: 'mcp/apps/toolCall', params: { threadId: current.widget.threadId, widgetId: current.widget.widgetId, revision: current.widget.revision, connectionId: current.widget.mcpApp.connectionId, operationId: 'history-negative', name: 'refresh', arguments: { value: 8 } } }) });
  if (denied.ok) throw new Error('Historical source retained executable backend authority');
  report.historyReadonly = (await backend('snapshot')).refreshCalls === 1;
  report.backend = await backend('snapshot');
  if (!report.childHasNoNativeApi || !report.parentDomBlocked || !report.declineVerified || !report.sameBackendProcess || !report.historyReadonly) throw new Error('Native joint boundary assertion failed');
  await finish(0);
} catch (error) { report.failure = String(error.message); await finish(1); }}
void run();
