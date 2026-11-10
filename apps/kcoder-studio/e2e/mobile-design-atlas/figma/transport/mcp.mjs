import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { syncRenderScene, syncSourceHash } from '../sync/core.mjs';

// Reuse Metro's locked pure-JS minifier; no additional binary/service is started.
const { minify } = createRequire(new URL('../../../../mobile/package.json', import.meta.url))('terser');

/** Compact transport for the MCP code-size limit, not encryption. */
export function packSyncData(value) {
  const input = Buffer.from(JSON.stringify(value), 'utf8').toString('latin1'), dictionary = new Map();
  let next = 256, prefix = '', codes = [];
  for (const ch of input) {
    const word = prefix + ch;
    if (word.length === 1 || dictionary.has(word)) prefix = word;
    else {
      codes.push(prefix.length === 1 ? prefix.charCodeAt(0) : dictionary.get(prefix));
      if (next < 65535) dictionary.set(word, next++);
      prefix = ch;
    }
  }
  if (prefix) codes.push(prefix.length === 1 ? prefix.charCodeAt(0) : dictionary.get(prefix));
  const out = Buffer.alloc(codes.length * 2); codes.forEach((c, i) => out.writeUInt16LE(c, i * 2));
  return out.toString('base64');
}

export const syncDecoderSource = `function unpackSyncData(encoded){
 const bytes=figma.base64Decode(encoded),dictionary=[];let next=256,previous='',out='';
 for(let i=0;i<bytes.length;i+=2){const code=bytes[i]+bytes[i+1]*256;
  const word=code<256?String.fromCharCode(code):dictionary[code]||(previous+previous[0]);
  out+=word;if(previous&&next<65535)dictionary[next++]=previous+word[0];previous=word;
 }
 return JSON.parse(decodeURIComponent(Array.from(out,c=>'%'+c.charCodeAt(0).toString(16).padStart(2,'0')).join('')));
}`;

/** Same updater as the native plugin. Callers persist the returned checkpoint delta. */
export async function makeMcpSyncScript(bundle, { stateIds, mode = 'apply' } = {}) {
  if (!['apply', 'preview'].includes(mode)) throw new Error('Unknown MCP sync mode');
  const selected = stateIds ? new Set(stateIds) : new Set(bundle.states.map(s => s.id));
  const states = bundle.states.filter(s => selected.has(s.id));
  if (states.length !== selected.size) throw new Error('Unknown selected state');
  const core = (await readFile(new URL('../sync/core.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '');
  const builder = (await readFile(new URL('../canvas/builder.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '');
  // A bounded MCP operation owns only its selected states; other routes are
  // retained by mergeSyncCheckpoint rather than redundantly transported.
  const routes = bundle.checkpoint.routes.filter(r => selected.has(r.stateId));
  const needed = new Set([...selected, ...routes.map(r => r.targetStateId), ...states.flatMap(s => (s.transition?.next || []).map(n => n.id))]);
  const data = { schema: bundle.schema, componentSourceHash: bundle.componentSourceHash,
    states: mode === 'preview' ? states.map(s => ({id:s.id,sourceHash:syncSourceHash(s)})) : states.map(s=>({...s,scene:syncRenderScene(s.scene)})), checkpoint: {
    schema: 1, fileKey: bundle.checkpoint.fileKey, pageNodeId: bundle.checkpoint.pageNodeId, rootNodeId: bundle.checkpoint.rootNodeId,
    states: bundle.checkpoint.states.filter(s => needed.has(s.stateId)).map(s => selected.has(s.stateId) ? s : { stateId: s.stateId, nodeId: s.nodeId }), routes } };
  const finish = mode === 'preview'
    ? 'return (await inspectSync(figma,bundle.checkpoint,bundle.states)).plan;'
    : `const result=await applySync(figma,bundle,buildEditableScreens);return {status:result.status,plan:result.plan,updated:result.updated,
       skippedDisabled:result.skippedDisabled,skippedAbsent:result.skippedAbsent,createdNodeIds:result.createdNodeIds,mutatedNodeIds:result.mutatedNodeIds,
       checkpointDelta:{states:result.checkpoint.states.filter(s=>bundle.states.some(b=>b.id===s.stateId)),
       routes:result.checkpoint.routes.filter(s=>bundle.states.some(b=>b.id===s.stateId)),updatedAt:result.checkpoint.updatedAt}};`;
  const raw = `${core}\n${mode === 'apply' ? builder : ''}\n${syncDecoderSource}\nconst bundle=unpackSyncData(${JSON.stringify(packSyncData(data))});\n${finish}`;
  const { code } = await minify(raw, { module: true, parse: { bare_returns: true }, compress: { toplevel: true }, mangle: { toplevel: true } });
  if (code.length > 49900) throw new Error(`MCP script has ${code.length} characters; select fewer states`);
  return code;
}

export function mergeSyncCheckpoint(checkpoint, delta) {
  const selected = new Set(delta.states.map(s => s.stateId));
  return { ...checkpoint, updatedAt: delta.updatedAt || checkpoint.updatedAt,
    states: checkpoint.states.map(s => delta.states.find(d => d.stateId === s.stateId) || s),
    routes: [...checkpoint.routes.filter(s => !selected.has(s.stateId)), ...delta.routes] };
}
