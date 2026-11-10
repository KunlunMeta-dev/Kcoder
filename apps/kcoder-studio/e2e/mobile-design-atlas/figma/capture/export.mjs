import assert from "node:assert/strict";
import { readFile, writeFile, access, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { runE2E, repoRoot } from "../../../harness/run-context.mjs";
import { startChromium } from "../../../harness/chromium.mjs";
import { startRecoveryFixture } from "../../../fixtures/mobile-send-recovery/server.mjs";
import { buildCurrentFixture } from "../../current-fixture/build.mjs";
import { captureMobileExportSourceSnapshot } from "../../../harness/mobile-export-source-snapshot.mjs";
import { writeFigmaSyncPackage } from "./package.mjs";
import { loadFigmaConfiguration, readFigmaTarget } from "../config.mjs";
import { currentCases } from "../../current-catalog.mjs";
import { resolvedTransition, validateTransitions } from "../../current-transitions.mjs";

process.umask(0o077);

// Export editable geometry from isolated actual components, never personal sessions.
function readScene() {
  const bounds = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const visible = (el, r) => {
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && +s.opacity !== 0 && r.w > 0 && r.h > 0 && r.x < innerWidth && r.x + r.w > 0 && r.y < innerHeight && r.y + r.h > 0;
  };
  const style = el => {
    const s = getComputedStyle(el);
    return Object.fromEntries(["backgroundColor", "backgroundImage", "color", "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius", "opacity", "overflowX", "overflowY", "fontSize", "fontFamily", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "textAlign", "textDecorationLine", "paddingTop", "paddingLeft", "paddingRight", "paddingBottom", "display", "flexDirection", "gap", "position", "alignItems", "justifyContent", "boxShadow"].map(k => [k, s[k]]));
  };
  const clips = el => {
    const result = [];
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(hidden|auto|scroll)/.test(s.overflowX + s.overflowY)) result.push(bounds(p));
    }
    return result;
  };
  const isClipped = (r, list) => list.some(c => r.x >= c.x+c.w || r.x+r.w <= c.x || r.y >= c.y+c.h || r.y+r.h <= c.y);
  let serial = 0;
  const visit = el => {
    const r = bounds(el);
    const computed=getComputedStyle(el);
    if(computed.display==="none"||computed.visibility==="hidden"||+computed.opacity===0)return null;
    const paints=visible(el,r)&&!isClipped(r,clips(el));
    const tag = el.tagName.toLowerCase(), s = style(el);
    const out = { key: `dom-${++serial}`, tag, name: el.getAttribute("data-testid") || el.getAttribute("aria-label") || tag,
      testId: el.getAttribute("data-testid"), label: el.getAttribute("aria-label"), role: el.getAttribute("role"),
      disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true", box: r, style: s, children: [] };
    if (tag === "svg") {
      if(!paints)return null;
      out.svg = new XMLSerializer().serializeToString(el);
      return out;
    }
    if (tag === "img") { if(!paints)return null;out.image = el.currentSrc || el.src; return out; }
    if (tag === "input" || tag === "textarea") {
      if(!paints)return null;
      out.text = el.value || el.placeholder || "";
      out.placeholder = !el.value;
      return out;
    }
    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (["SCRIPT", "STYLE", "LINK", "NOSCRIPT"].includes(child.tagName)) continue;
        const item = visit(child); if (item) out.children.push(item);
      } else if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
        const lines = [];
        const text = child.textContent;
        for (let i = 0; i < text.length; i++) {
          const range = document.createRange();range.setStart(child, i);range.setEnd(child, i+1);
          const cr = range.getBoundingClientRect();
          if (!cr.width || !cr.height) continue;
          let line = lines.at(-1);
          if (!line || Math.abs(line.y-cr.y) > 2) { line = {text:"",x:cr.x,y:cr.y,w:0,h:cr.height};lines.push(line); }
          line.text += text[i];line.w = cr.right-line.x;
        }
        for (const line of lines) if (line.text.trim() && line.y < innerHeight && line.y+line.h>0 && !isClipped(line, clips(el))) {
          out.children.push({ key:`dom-${++serial}`, tag:"text", name:line.text.slice(0,36), box:line, text:line.text, style:s, children:[] });
        }
      }
    }
    // Portals can have a zero-sized host with viewport-sized fixed descendants.
    return paints||out.children.length?out:null;
  };
  return { width:innerWidth,height:innerHeight,root:visit(document.body),title:document.title };
}

async function enterState(page, source, base) {
  const query = new URL(source, "http://fixture.invalid/").searchParams;
  await page.goto(`${base}?${new URLSearchParams({state:query.get("state"),width:"390",language:"zh-CN",theme:"light"})}`, {waitUntil:"load"});
  await page.getByTestId("current-v3-fixture").waitFor();
  if(query.get("state")==="selection-collapsed"){
    const toggle=page.getByTestId("toggle-server-api");
    if(await toggle.getAttribute("aria-expanded")==="true")await toggle.press("Enter");
  }
  const action = query.get("action");
  // Sample the existing keyboard activation path; do not force a blocked pointer hit.
  if (action === "project") await page.getByTestId("v3-project-folder-api-1").press("Enter");
  if (action === "edit") await page.getByTestId("task-goal-edit").click();
  if (action === "details") await page.getByTestId("task-goal-expand").click();
  if (action === "navigation") await page.getByTestId("v3-conversation-menu").click();
  if (action === "agents-list" || action === "agent-conversation") {
    await page.getByTestId("task-more").click();
    await page.getByTestId("mobile-subagents-open").click();
    await page.getByTestId("mobile-subagent-list").waitFor();
    if (action === "agent-conversation") await page.getByTestId("mobile-subagent-layout-agent").click();
  }
  if (action === "phrase-edit") await page.getByTestId("quick-phrase-edit-review").click();
  if (action === "reply-more") await page.getByTestId("assistant-response-more").click();
  if (action === "thinking") await page.locator('[data-testid$="-toggle"]:visible').first().click();
  if (action === "plan") await page.getByTestId("task-plan-summary").click();
  if (action === "plan-scroll") await page.getByTestId("fixture-transcript").evaluate(node => { node.scrollTop = 320; });
  if (action === "code") await page.getByRole("button").filter({hasText:"2 行"}).first().click();
  if (action === "table") await page.getByTestId("markdown-table-expand").click();
  if (action === "table-more") await page.getByTestId("markdown-table-more").click();
  await page.evaluate(async()=>{await document.fonts.ready;document.activeElement?.blur();for(const a of document.getAnimations()){try{a.finish();}catch{a.pause();}}});
  await page.waitForTimeout(100);
}

async function checkComposerEndAlignment(page, stateId) {
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="composer-toolbar"]')).flatMap(toolbar => {
    const send = toolbar.querySelector('[data-testid="send-message"]');
    if (!send) return [];
    const t = toolbar.getBoundingClientRect(), b = send.getBoundingClientRect();
    if (!t.width || !b.width) return [];
    return [{ stateId: null, viewport: innerWidth, toolbarRight: t.right, sendX: b.x, sendWidth: b.width,
      rightGap: t.right - b.right, expectedGap: parseFloat(getComputedStyle(toolbar).paddingRight) || 0 }];
  }));
  if (stateId === "DRAFT-01" || stateId === "CHAT-01") assert.equal(rows.length, 1, `${stateId}: expected one visible composer`);
  for (const row of rows) {
    row.stateId = stateId;
    assert.ok(Math.abs(row.rightGap - row.expectedGap) <= 1,
      `${stateId}: send button is not aligned with the toolbar end: ${JSON.stringify(row)}`);
  }
  return rows;
}

export async function exportFigmaReference(sourceUrl) {
const configuration = await loadFigmaConfiguration(repoRoot);
await readFigmaTarget(configuration);
const environment = { ...process.env, ...configuration.environment };
return runE2E(sourceUrl, {testId:"figma-reference-export",tier:"manual-live",retainSuccessLogs:true,
  modelPolicy:"Offline synthetic V3 component geometry and prototype-reference export only; no Gateway, personal state, providers or product writes"}, async run => {
  const catalog = JSON.parse(await readFile(resolve(repoRoot,"docs/phone/show/catalog.json"),"utf8"));
  validateTransitions(currentCases);
  catalog.states = currentCases.map(([id,title,group,state,condition,recipe,action]) => ({id,title,group,condition,recipe,
    variants:[{source:`current-fixture/App.tsx?state=${state}${action?`&action=${action}`:""}`}],transition:resolvedTransition(id,currentCases)}));
  if(environment.KCODER_FIGMA_SUPPLEMENTAL==="1"||environment.KCODER_FIGMA_SYNC==="1"){
    const specs=[
      ["SUP-GOAL-01","运行中目标：编辑","goal-active","edit","GOAL-01"],
      ["SUP-GOAL-02","运行中目标：展开详情","goal-active","details","GOAL-01"],
      ["SUP-THINK-01","进行中思考：展开","thinking-running","thinking","THINK-01"],
      ["SUP-THINK-02","已停止思考：展开","thinking-stopped","thinking","THINK-03"],
      ["SUP-PLAN-01","任务清单：折叠","plan","","PLAN-01"],
      ["SUP-CODE-01","Markdown代码：展开","reply","code","CHAT-01"],
      ["SUP-TABLE-01","Markdown表格：放大","reply","table","CHAT-01"],
      ["SUP-TABLE-02","Markdown表格：更多","reply","table-more","CHAT-01"],
    ];
    catalog.states.push(...specs.map(([id,title,state,action,from])=>({id,title,group:"supplement",condition:"从实际同一状态触发，仅改变展开/编辑/查看方式，不改变运行状态。",
      variants:[{source:`current-fixture/App.tsx?state=${state}${action?`&action=${action}`:""}`}],
      transition:{from:[{id:from,label:from}],trigger:{kind:"action",steps:[`从 ${from} 触发 ${title} 的实际组件操作`]},requires:[],next:[{id:from,label:from,kind:"action",text:"关闭或折叠，返回原状态"}],note:"真实冻结组件的补充采样；不是新增产品功能。"}})));
  }
  if(environment.KCODER_FIGMA_STATE_IDS){const ids=new Set(environment.KCODER_FIGMA_STATE_IDS.split(","));catalog.states=catalog.states.filter(s=>ids.has(s.id));assert.equal(catalog.states.length,ids.size,"Unknown requested state ID");}
  let built;
  if (environment.KCODER_FIGMA_REUSE_EXPORT) {
    const prior=resolve(environment.KCODER_FIGMA_REUSE_EXPORT);
    const previous=JSON.parse(await readFile(resolve(prior,"frozen-mobile-source.json"),"utf8"));
    const source=await captureMobileExportSourceSnapshot({snapshotRoot:run.pathInState("frozen-source"),layout:"preflight-source-root",freezeFiles:true,
      sourceRoots:[{name:"mobile",path:resolve(repoRoot,"apps/kcoder-studio/mobile"),destination:"apps/kcoder-studio/mobile"},
        {name:"studio-shared",path:resolve(repoRoot,"apps/kcoder-studio/shared"),destination:"apps/kcoder-studio/shared"}]});
    const renderInputs=files=>files.filter(f=>!f.path.split("/").includes("__tests__")&&!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f.path));
    assert.deepEqual(renderInputs(source.files),renderInputs(previous.files),"Render source changed since the export");
    const hashes=JSON.parse(await readFile(resolve(prior,"static-files.json"),"utf8"));
    const priorOutput=resolve(prior,"site/fixtures/mobile-send-recovery-v3");
    for(const file of hashes) assert.equal(createHash("sha256").update(await readFile(resolve(priorOutput,file.path))).digest("hex"),file.sha256);
    const output=run.pathInArtifacts("site/fixtures/mobile-send-recovery-v3");
    await cp(priorOutput,output,{recursive:true});
    await run.writeArtifactJson("frozen-mobile-source.json",source);
    await run.writeArtifactJson("reused-export.json",{prior,assetsVerified:hashes.length,renderInputsIdentical:true});
    built={output,source};
  } else built = await buildCurrentFixture(run);
  if(environment.KCODER_FIGMA_CAPTURE_ID){
    const index=resolve(built.output,"index.html");
    const html=await readFile(index,"utf8");
    await writeFile(index,html.replace("</head>",'<script src="https://mcp.figma.com/mcp/html-to-design/capture.js" async></script></head>'));
  }
  const base = await startRecoveryFixture(run,built.output);
  const browser = await startChromium(run,{label:"figma-reference-export",noSandbox:true});
  const page = await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  const states=[], composerLayouts=[];
  for (const state of catalog.states) {
    await enterState(page,state.variants[0].source,base);
    if (state.id === "DRAFT-01") {
      await page.setViewportSize({width:320,height:844});
      composerLayouts.push(...await checkComposerEndAlignment(page,state.id));
      await page.screenshot({path:run.pathInArtifacts("DRAFT-01-320.png")});
      await page.setViewportSize({width:390,height:844});
    }
    composerLayouts.push(...await checkComposerEndAlignment(page,state.id));
    const scene=await page.evaluate(readScene);
    await page.screenshot({path:run.pathInArtifacts(`${state.id}.png`)});
    states.push({id:state.id,title:state.title,group:state.group,condition:state.condition,source:state.variants[0].source,transition:state.transition,scene});
    console.log(`[Figma reference] ${states.length}/${catalog.states.length} ${state.id}`);
  }
  assert.equal(errors.length,0,`Component page errors: ${errors.join("; ")}`);
  await run.writeArtifactJson("composer-layout-checks.json",composerLayouts);
  const data={catalogEdition:catalog.edition,catalogSourceHash:catalog.rendererTreeSha256,sourceHash:built.source.sourceTreeSha256,
    sourceBoundary:"Catalog states sampled from current source-frozen actual components; optional explicit state subset and supplemental samples.",groups:catalog.groups,states};
  await run.writeArtifactJson("editable-scenes.json",data);
  if(environment.KCODER_FIGMA_SYNC==="1"){
    const sync=await writeFigmaSyncPackage({artifactsDir:run.artifactsDir,data,checkpointPath:environment.KCODER_FIGMA_CHECKPOINT});
    console.log(`FIGMA_SYNC_READY ${sync.output}`);
  }
  await run.writeArtifactJson("ready.json",{base,artifactsDir:run.artifactsDir,stateCount:states.length,errors});
  console.log(`FIGMA_EXPORT_READY ${run.artifactsDir}`);
  if(environment.KCODER_FIGMA_EXPORT_ONLY==="1"||!environment.KCODER_FIGMA_CAPTURE_ID)return{stateCount:states.length,artifactsDir:run.artifactsDir,externalProductCalls:0};
  if(environment.KCODER_FIGMA_CAPTURE_ID){
    const capture=new URL(base);capture.searchParams.set("state","draft");
    const id=environment.KCODER_FIGMA_CAPTURE_ID;
    capture.hash=new URLSearchParams({figmacapture:id,figmaendpoint:`https://mcp.figma.com/mcp/capture/${id}/submit?bindVariables=true`,figmadelay:"2000"}).toString();
    await page.goto(capture.href,{waitUntil:"load"});
  }
  // Keep only this owned static server alive for the explicitly requested capture.
  const stopFile=run.pathInArtifacts("stop-capture");
  const deadline=Date.now()+45*60_000;
  while(Date.now()<deadline){try{await access(stopFile);break;}catch{await new Promise(r=>setTimeout(r,1000));}}
  return {stateCount:states.length,artifactsDir:run.artifactsDir,externalProductCalls:0};
});
}
