// Runtime alias of this versioned bootstrap belongs only to the exact owned root.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const input=JSON.parse((await readFile(process.argv[2],'utf8')).replace(/^\uFEFF/,''));
const {run}=await import(pathToFileURL(join(input.root,'source/apps/kcoder-studio/e2e/harness/windows-widget-interactive-run.mjs')));
await run(input);
