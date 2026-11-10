import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { packSyncData, syncDecoderSource } from './mcp.mjs';
const { minify } = createRequire(new URL('../../../../mobile/package.json', import.meta.url))('terser');

export async function makeRegistrationScript(checkpoint, manifest) {
  const core = (await readFile(new URL('../sync/core.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '');
  const registration = (await readFile(new URL('../canvas/register.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const data = packSyncData({ checkpoint, manifest });
  const raw = `${core}\n${registration}\n${syncDecoderSource}\nconst data=unpackSyncData(${JSON.stringify(data)});const result=await registerReferenceAnchors(figma,data.checkpoint,data.manifest.states,data.manifest.sectionName);return{createdNodeIds:result.createdNodeIds,mutatedNodeIds:result.mutatedNodeIds,sectionId:result.sectionId,pendingStates:result.pendingStates,anchors:result.checkpoint.states.filter(s=>result.pendingStates.includes(s.stateId))};`;
  const { code } = await minify(raw, { module: true, parse: { bare_returns: true }, compress: { toplevel: true }, mangle: { toplevel: true } });
  if (code.length > 49900) throw new Error('Registration exceeds the MCP script limit');
  return code;
}
