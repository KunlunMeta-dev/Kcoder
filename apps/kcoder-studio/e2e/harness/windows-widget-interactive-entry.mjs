// Runtime alias of this versioned bootstrap belongs only to the exact owned root.
import { readFile, mkdir } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
const input=JSON.parse((await readFile(process.argv[2],'utf8')).replace(/^\uFEFF/,''));
if(input.suite==='storage-dialog-cancel'){
  const marker=JSON.parse((await readFile(join(input.root,'.owner.json'),'utf8')).replace(/^\uFEFF/,''));
  if(marker.owner!==input.owner||win32.resolve(input.root).toLowerCase()!==win32.resolve('C:/kcoder-widget-'+input.owner).toLowerCase())throw Error('Original native-dialog owner changed');
  const temporary=join(input.root,'bootstrap-temp');await mkdir(temporary,{recursive:false});
  for(const name of ['TEMP','TMP','TMPDIR'])process.env[name]=temporary;
}
const {run}=await import(pathToFileURL(join(input.root,'source/apps/kcoder-studio/e2e/harness/windows-widget-interactive-run.mjs')));
await run(input);
