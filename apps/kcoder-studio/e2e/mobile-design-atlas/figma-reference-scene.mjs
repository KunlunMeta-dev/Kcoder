export * from './figma/capture/scene.mjs';
import { writeCompactScenes } from './figma/capture/scene.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await writeCompactScenes(process.argv[2]);
