import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeSyncResult, atomicSyncJson } from '../sync/job.mjs';

export async function auditFigmaReference(call, sessionId, checkpoint, { includeEdges = true } = {}) {
  const core=(await readFile(new URL('../sync/core.mjs',import.meta.url),'utf8')).replace(/^export /gm,'');
  const code=core+`\nconst root=await figma.getNodeByIdAsync(${JSON.stringify(checkpoint.rootNodeId)});if(!root||root.type!=="SECTION")throw new Error("Missing REF root");if(figma.currentPage.id!==root.parent.id)await figma.setCurrentPageAsync(root.parent);
const nodes=syncWalk(root),ids=new Set(nodes.map(n=>n.id)),edges=[];
for(const n of nodes)if("reactions"in n)for(const r of n.reactions)for(const a of r.actions||(r.action?[r.action]:[]))if(a.type==="NODE"||a.type==="BACK")edges.push([n.id,a.destinationId||null,a.type]);
return{rootNodeId:root.id,bounds:{x:root.x,y:root.y,width:root.width,height:root.height},originalAreaHash:syncNodeHash({children:figma.currentPage.children.filter(n=>n.id!==root.id)}),
frames:nodes.filter(n=>n.type==="FRAME"&&n.name.startsWith("REF-V3 / ")).map(n=>n.id),emptyFrames:nodes.filter(n=>n.type==="FRAME"&&n.name.startsWith("REF-V3 / ")&&!n.children.length).map(n=>n.id),
missing:edges.filter(e=>e[1]&&!ids.has(e[1])),temporary:nodes.filter(n=>n.name.includes("staging")).map(n=>n.id),${includeEdges?'edges,':''}
flowStartingPoints:figma.currentPage.flowStartingPoints,ownedFlowStartingPoints:figma.currentPage.flowStartingPoints.filter(f=>ids.has(f.nodeId))};`;
  return decodeSyncResult(await call('use_figma',{fileKey:checkpoint.fileKey,sessionId,skillNames:'figma-use',description:'Audit owned REF frames, original area and prototype destinations',code}));
}

export async function updateReferenceIndex(path, checkpoint, audit, bundle) {
  const original=await readFile(path,'utf8'),index=JSON.parse(original);
  assert.equal(index.fileKey,checkpoint.fileKey,'Index Figma file mismatch');assert.equal(index.rootNodeId,checkpoint.rootNodeId,'Index REF region mismatch');
  assert.equal(audit.missing.length,0,'Prototype destinations missing');assert.equal(audit.temporary.length,0,'Staging layers remain');assert.equal(audit.emptyFrames.length,0,'Empty REF frames');
  const next={...index,componentSourceSnapshot:bundle.componentSourceHash,bounds:audit.bounds,edges:audit.edges,
    flowStartingPoints:audit.flowStartingPoints,lastSyncedAt:new Date().toISOString(),revision:'automated-source-sync',
    counts:{...index.counts,referenceScreens:audit.frames.length,prototypeStarts:audit.ownedFlowStartingPoints.length,
      interactiveNodes:new Set(audit.edges.map(e=>e[0])).size,navigateActions:audit.edges.filter(e=>e[2]==='NODE').length,backActions:audit.edges.filter(e=>e[2]==='BACK').length}};
  if(await readFile(path,'utf8')!==original)throw new Error('Reference index changed concurrently');
  await atomicSyncJson(path,next);
}
