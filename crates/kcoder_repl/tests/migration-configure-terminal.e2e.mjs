// Actual node-pty and official xterm/WebGL exercise only owned local migration prompts.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium } from "../../../tools/tui-lab/node_modules/@playwright/test/index.mjs";
import { parseArgs, defaultCommandString, browserLaunchOptions } from "../../../tools/tui-lab/lib/runner-options.mjs";
import { createRunContext } from "../../../tools/tui-lab/lib/run-context.mjs";
import { defaultWorkspaceTemplate, repoRoot, runContextRuntime } from "../../../tools/tui-lab/lib/runtime-paths.mjs";
import { startSession } from "../../../tools/tui-lab/lib/session.mjs";
import { typeHumanText, waitForTerminalText } from "../../../tools/tui-lab/lib/terminal-interaction.mjs";
import { writeStartMeta, writeJsonArtifact, writeTextArtifact, writeFailureArtifacts } from "../../../tools/tui-lab/lib/runtime-artifacts.mjs";
import { attachBrowserConsole } from "../../../tools/tui-lab/lib/browser-evidence.mjs";

assert.equal(process.platform,"linux","Windows/macOS require their native host acceptance.");
const options=parseArgs(["run","--software-webgl","--cols","180","--rows","95",...process.argv.slice(2)],{defaultWorkspaceTemplate});
assert.ok(options.description,"Pass --description to retain real-terminal evidence.");options.repoRoot=repoRoot;
const artifacts=await createRunContext(options,"migration-configure-terminal",runContextRuntime());
const sourceBinary=process.env.KCODER_MIGRATION_TUI_BINARY||path.join(repoRoot,"target/debug/kcoder");
const binary=path.join(artifacts.configHome,"owned-bin/kcoder");await fs.mkdir(path.dirname(binary),{recursive:true,mode:0o700});
await fs.copyFile(sourceBinary,binary);await fs.chmod(binary,0o700);
options.commandOverride=`exec '${binary.replaceAll("'","'\\''")}' --cwd {workspace} tui-dev --scenario full-turn`;
const runOptions={...options,runDir:artifacts.dir,workspaceDir:artifacts.workspace,requestsDir:artifacts.requestsDir,configHome:artifacts.configHome};
const command=defaultCommandString(runOptions);await writeStartMeta(artifacts,runOptions,command,"migration-configure-terminal");
const sourceHome=path.join(artifacts.workspace,"owned-source-home"),vendor=path.join(sourceHome,".claude");
await fs.mkdir(path.join(vendor,"skills/office-report"),{recursive:true,mode:0o700});
const secret="SYNTHETIC_GUIDE_TUI_PRIVATE_VALUE";
const marker=path.join(artifacts.workspace,"SOURCE_PROGRAM_MUST_NOT_EXECUTE");
const sourceProgram=path.join(vendor,"never-run.sh");
await fs.writeFile(sourceProgram,`#!/bin/sh\nprintf source-executed > '${marker.replaceAll("'","'\\''")}'\n`,{mode:0o700});
const source=JSON.stringify({model:"unselected-source-model",env:{ANTHROPIC_BASE_URL:"https://example.invalid/v1",ANTHROPIC_API_KEY:secret},mcpServers:{docs:{command:sourceProgram,env:{TOKEN:secret}}}});
await fs.writeFile(path.join(vendor,"settings.json"),source,{mode:0o600});
await fs.writeFile(path.join(vendor,"skills/office-report/SKILL.md"),"---\nname: office-report\ndescription: Summarize office reports\n---\nKeep original documents intact.\n",{mode:0o600});
await fs.writeFile(path.join(vendor,"CLAUDE.md"),"Preserve original office documents.\n",{mode:0o600});
await fs.writeFile(path.join(vendor,"auth.json"),"MUST_NOT_READ_AUTH_CACHE",{mode:0o600});
const selectedHistoryId=crypto.randomUUID(),selectedHistoryDir=path.join(vendor,"projects/explicit-office-history");
await fs.mkdir(selectedHistoryDir,{recursive:true,mode:0o700});
const selectedHistoryFile=path.join(selectedHistoryDir,`${selectedHistoryId}.jsonl`);
const selectedHistoryBytes=JSON.stringify({type:"user",uuid:"office",sessionId:selectedHistoryId,version:"2.1.301",message:{role:"user",content:"Owned office archive selected explicitly"}})+"\n";
await fs.writeFile(selectedHistoryFile,selectedHistoryBytes,{mode:0o600});
const pluginPackage=path.join(vendor,"plugins/cache/market/office-pack/1.0.0");
await fs.mkdir(path.join(pluginPackage,".claude-plugin"),{recursive:true,mode:0o700});
await fs.mkdir(path.join(pluginPackage,"skills/check"),{recursive:true,mode:0o700});
await fs.writeFile(path.join(pluginPackage,".claude-plugin/plugin.json"),JSON.stringify({name:"office-pack",version:"1.0.0",mcpServers:{documents:{command:sourceProgram}},hooks:{SessionStart:[{hooks:[{type:"command",command:sourceProgram}]}]}}),{mode:0o600});
await fs.writeFile(path.join(pluginPackage,"skills/check/SKILL.md"),"---\nname: check\ndescription: Check office evidence\n---\nCite supplied source documents.\n",{mode:0o600});
await fs.writeFile(path.join(vendor,"plugins/installed_plugins.json"),JSON.stringify({version:2,plugins:{"office-pack@market":[{scope:"user",installPath:pluginPackage,version:"1.0.0"}]}}),{mode:0o600});
await fs.mkdir(artifacts.configDir,{recursive:true,mode:0o700});
const settings=JSON.stringify({provider:"local",local_base_url:"http://127.0.0.1:9",api_format:"openai_chat_completions",model:"fixture-model",context_window_tokens:1000000,context_output_headroom:10000,max_tokens:2048,credential_store:"file"});
await fs.writeFile(path.join(artifacts.configDir,"settings.json"),settings,{mode:0o600});
let session,browser,page,currentId="",jobId,archivedChild,pluginOperation;const browserConsole=[],trace=[];
const questionCodes={"选择操作":"menu","选择迁移项目":"selection","选择历史文件":"history_selection","选择插件包":"plugin_selection","核对插件操作身份":"plugin_request_id","确认插件静态复制":"plugin_capture_consent","确认纳入插件副本":"plugin_use_consent","确认插件选择范围":"plugin_partial_consent","设置插件安装标识名":"plugin_target_name","浏览迁移结果":"results_page","设置目标名称":"target_name","设置 MCP 工作目录":"mcp_cwd","核对操作身份":"request_id","授权所选私有字段":"mcp_private_consent","确认资产启用":"enable_asset","确认 MCP 启用":"enable_mcp","确认已有结果复用":"reuse","确认目标变更":"confirm_operation"};
const localMigration=(args)=>JSON.parse(execFileSync(binary,["--cwd",artifacts.workspace,"migrate",...args],{encoding:"utf8",timeout:60000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,HOME:artifacts.configHome,USERPROFILE:artifacts.configHome,KCODER_CONFIG_DIR:artifacts.configDir,KCODER_TUI_LAB_REQUEST_DIR:artifacts.requestsDir}}));
const plugin=(args)=>localMigration(["plugin","--target-profile",artifacts.configDir,...args]);
const text=()=>page.evaluate(()=>window.tuiLab.text());
async function send(line){await page.evaluate(()=>window.tuiLab.focus());await typeHumanText(page,line);await page.evaluate(()=>window.tuiLab.sendInput("\r"));}
async function prompt(){
  await page.waitForFunction(previous=>{const ids=Array.from(window.tuiLab.text().matchAll(/\/migrate answer ([a-f0-9]{12,32})/g));return ids.length&&ids.at(-1)[1]!==previous;},currentId,{timeout:45000});
  const screen=await text();assert.ok(!screen.includes(secret),"Private values must never enter the terminal projection");
  assert.ok(!screen.includes("本地迁移未完成"),screen);
  const ids=Array.from(screen.matchAll(/\/migrate answer ([a-f0-9]{12,32})/g));currentId=ids.at(-1)[1];
  const labels=Array.from(screen.matchAll(/当前问题：([^\n┃│]+)/g));assert.ok(labels.length,screen);
  const label=labels.at(-1)[1].trim(),code=questionCodes[label];assert.ok(code,`Unknown visible question label ${label}`);
  trace.push({promptId:currentId,label});return {screen,code,id:currentId};
}
async function answer(value){trace.push({answer:value});await send(`/migrate answer ${currentId} ${JSON.stringify(value)}`);}
try {
  session=await startSession(runOptions);browser=await chromium.launch(browserLaunchOptions(options));
  page=await browser.newPage({viewport:{width:1700,height:1900}});attachBrowserConsole(page,browserConsole);
  await page.goto(session.url);await page.waitForFunction(()=>window.tuiLab?.ready,null,{timeout:options.timeoutMs});
  await waitForTerminalText(page,"TUI dev mode",options.timeoutMs);assert.equal(await page.evaluate(()=>window.tuiLab.renderer),"webgl");
  await send(`/migrate configure --source claude-code --source-home "${sourceHome}" --include-history --include-plugins`);
  let next=await prompt();assert.equal(next.code,"history_selection");
  await page.screenshot({path:path.join(artifacts.dir,"migration-configure-history-selection.png")});
  await answer("toggle 1");next=await prompt();assert.equal(next.code,"history_selection");await answer("done");
  next=await prompt();assert.equal(next.code,"plugin_selection");
  await page.screenshot({path:path.join(artifacts.dir,"migration-configure-plugin-selection.png")});
  await answer("select 1");next=await prompt();assert.equal(next.code,"plugin_request_id");await answer("");
  next=await prompt();assert.equal(next.code,"plugin_capture_consent");assert.ok(next.screen.includes("首次 IMPORT"));await answer("yes");
  next=await prompt();assert.equal(next.code,"plugin_use_consent");await page.screenshot({path:path.join(artifacts.dir,"migration-configure-plugin-captured-review.png")});await answer("yes");
  next=await prompt();assert.equal(next.code,"plugin_selection");await answer("done");
  next=await prompt();if(next.code==="plugin_partial_consent"){await answer("yes");next=await prompt();}assert.equal(next.code,"menu");
  await send("/migrate answer 00000000-0000-0000-0000-000000000000 yes");await waitForTerminalText(page,"未接受回答",10000);
  await answer("select");
  const selected=new Set();let imported=false,rejected=false,lastCategory;
  for(let count=0;count<60;count++){
    next=await prompt();const screen=next.screen;
    let response;
    if(next.code==="selection"){
      if(selected.size===0)await page.screenshot({path:path.join(artifacts.dir,"migration-configure-selection.png")});
      const categories={"MCP":"mcp","技能":"skill","指令":"instructions","历史":"history","插件包":"plugin"};
      const selectionPage=screen.split(/第 \d+\/\d+ 页 · 已选 \d+ 项/).at(-1);
      const rows=Array.from(selectionPage.matchAll(/^\s*(\d+)\. \[[ x]\] (\S+) "([^"\n]+)"/gm)).map(m=>({category:categories[m[2]],name:m[3],number:Number(m[1])}));
      const row=rows.find(r=>["mcp","skill","instructions","history","plugin"].includes(r.category)&&!selected.has(r.category));
      if(row){selected.add(row.category);lastCategory=row.category;response=`toggle ${row.number}`;}
      else {assert.equal(selected.size,5,screen);response="preview";}
    } else if(next.code==="target_name"){
      response=lastCategory==="mcp"?"terminal-docs":lastCategory==="skill"?"terminal-report":"terminal-instructions";
    } else if(next.code==="plugin_target_name")response="terminal-plugin";
    else if(next.code==="mcp_cwd"||next.code==="request_id")response="";
    else if(next.code==="mcp_private_consent"||next.code==="enable_asset")response="yes";
    else if(next.code==="enable_mcp"||next.code==="reuse")response="no";
    else if(next.code==="confirm_operation"){
      if(!rejected)await page.screenshot({path:path.join(artifacts.dir,"migration-configure-confirmation.png")});
      if(!rejected){response="no";rejected=true;assert.equal(await fs.readFile(path.join(artifacts.configDir,"settings.json"),"utf8"),settings);}
      else response="IMPORT";
    } else if(next.code==="menu"){
      const ids=Array.from(screen.matchAll(/"jobId":\s*"(mig-[a-f0-9]{32})"/g));jobId=ids.at(-1)?.[1]||jobId;
      if(screen.includes('"status": "completed_with_issues"')){imported=true;await answer("results");next=await prompt();assert.equal(next.code,"results_page");const planned=localMigration(["items","--target-profile",artifacts.configDir,"--job-id",jobId]).planned;archivedChild=planned.find(item=>item.historyJobId)?.historyJobId;const copies=plugin(["records"]).items.filter(item=>item.batchJobId===jobId);assert.equal(copies.length,1,"The selected package must remain attached to this exact parent");pluginOperation=copies[0].operationId;assert.ok(archivedChild&&pluginOperation,JSON.stringify(planned));const importedPlugin=plugin(["read","--operation-id",pluginOperation]);assert.equal(importedPlugin.stage,"imported");assert.match(importedPlugin.targetId,/^terminal-plugin@migrated-[a-f0-9]+$/);await answer("back");next=await prompt();assert.equal(next.code,"menu");await answer("quit");break;}
      response="apply";
    } else throw new Error(`Unexpected real terminal prompt ${next.code}`);
    await answer(response);
  }
  assert.ok(imported&&jobId,"The selected native batch must finish with an authoritative receipt");
  await waitForTerminalText(page,"本地迁移向导已退出",15000);
  await page.screenshot({path:path.join(artifacts.dir,"migration-configure-imported.png")});
  assert.equal(await fs.readFile(path.join(vendor,"settings.json"),"utf8"),source);
  assert.equal(await fs.readFile(selectedHistoryFile,"utf8"),selectedHistoryBytes);
  assert.equal(await fs.access(marker).then(()=>true,()=>false),false,"Source MCP command must not execute");
  assert.ok((await fs.readFile(path.join(artifacts.configDir,"credentials.json"),"utf8")).includes(secret));
  await fs.rename(vendor,path.join(sourceHome,"vendor-withheld"));
  await send(`/migrate configure --job-id ${jobId}`);next=await prompt();assert.equal(next.code,"menu");await answer("undo");
  next=await prompt();assert.equal(next.code,"request_id");await answer("");
  next=await prompt();assert.equal(next.code,"confirm_operation");await answer("UNDO");
  next=await prompt();assert.equal(next.code,"menu");assert.ok(next.screen.includes('"status": "rollback_conflict"'),next.screen);await answer("quit");
  await waitForTerminalText(page,"本地迁移向导已退出",15000);
  const restored=JSON.parse(await fs.readFile(path.join(artifacts.configDir,"settings.json"),"utf8"));assert.deepEqual(restored,JSON.parse(settings));
  assert.equal(plugin(["read","--operation-id",pluginOperation]).stage,"undone","Unified Undo retires the same owned plugin after the source is withheld");
  await page.screenshot({path:path.join(artifacts.dir,"migration-configure-reopened-undone.png")});
  const historyRoot=path.join(artifacts.workspace,"owner-switch-source");
  await fs.mkdir(path.join(historyRoot,"projects/owned"),{recursive:true,mode:0o700});
  const historyId=crypto.randomUUID(),historyJob=crypto.randomUUID();
  await fs.writeFile(path.join(historyRoot,"projects/owned",`${historyId}.jsonl`),JSON.stringify({type:"user",uuid:"owner",sessionId:historyId,version:"2.1.301",message:{role:"user",content:"OWNER_SWITCH_RUNTIME_SEED"}})+"\n",{mode:0o600});
  const history=(args)=>JSON.parse(execFileSync(binary,["--cwd",artifacts.workspace,"migrate","history","--target-profile",artifacts.configDir,...args],{encoding:"utf8",timeout:60000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,HOME:artifacts.configHome,USERPROFILE:artifacts.configHome,KCODER_CONFIG_DIR:artifacts.configDir,KCODER_TUI_LAB_REQUEST_DIR:artifacts.requestsDir}}));
  assert.equal(history(["read","--job-id",archivedChild]).stage,"normalized","History retirement is blocked explicitly; ordinary Undo must not delete the historical child");
  history(["select","--source","claude-code","--source-root",historyRoot,"--source-session-id",historyId,"--request-id",historyJob]);
  history(["run","--job-id",historyJob,"--expected-sequence","0"]);const branch=history(["branch","--job-id",historyJob]);
  const continued=history(["continue","--job-id",historyJob,"--view-id",branch.progress.viewId,"--request-id",crypto.randomUUID()]);assert.equal(continued.job.stage,"imported");
  await send(`/migrate configure --job-id ${jobId}`);next=await prompt();assert.equal(next.code,"menu");const expired=next.id;
  await send(`/resume ${continued.job.threadId}`);await waitForTerminalText(page,"Resumed session from",15000);
  await send(`/migrate answer ${expired} apply`);await waitForTerminalText(page,"未接受回答",15000);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(artifacts.configDir,"settings.json"),"utf8")),JSON.parse(settings));
  assert.ok(!(await text()).includes("OWNER_SWITCH_RUNTIME_SEED"),"Runtime migration seed must not become visible user content");
  await page.screenshot({path:path.join(artifacts.dir,"migration-configure-owner-change.png")});
  const requests=await fs.readdir(artifacts.requestsDir).catch(e=>{if(e.code==="ENOENT")return [];throw e;});assert.equal(requests.filter(p=>p.endsWith(".json")).length,0);
  const assertions={ok:true,mode:"migration-configure-terminal",renderer:"webgl",staleAnswerRejected:true,sourceNotExecuted:true,sourceUnchanged:true,explicitSelection:selected.size,pluginOperationId:pluginOperation,pluginAlias:"terminal-plugin",ownedPluginUndoneAfterSourceWithheld:true,archivedHistoricalChild:archivedChild,historyRetirementExplicitlyBlocked:true,nativeHistoryPreservedAfterUndo:true,privateValuesNotEchoed:true,confirmationRequired:true,reopenedWithoutSource:true,explicitAssetUndo:true,sessionChangeStopsOwnedPrompt:true,expiredOwnerAnswerRejected:true,runtimeSeedHidden:true,modelRequests:0,binarySha256:crypto.createHash("sha256").update(await fs.readFile(binary)).digest("hex"),trace};
  await writeTextArtifact(path.join(artifacts.dir,"screen.txt"),await text());await writeJsonArtifact(path.join(artifacts.dir,"assertions.json"),assertions);
  await browser.close();browser=undefined;await session.stop();await session.exitPromise;
  await writeJsonArtifact(path.join(artifacts.dir,"meta.json"),{...assertions,ptyExit:session.getExitInfo(),diagnostics:session.getDiagnostics()});console.log(JSON.stringify({ok:true,directory:artifacts.dir,assertions},null,2));
}catch(error){await writeFailureArtifacts({artifacts,runOptions,command,mode:"migration-configure-terminal",session,page,browserConsole,trace,error});throw error;}
finally{if(browser)await browser.close();if(session)await session.stop();}
