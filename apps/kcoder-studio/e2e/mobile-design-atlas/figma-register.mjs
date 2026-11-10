import { registerFigmaStates } from './figma/sync/register.mjs';
await registerFigmaStates(import.meta.url, process.argv[2], process.argv[3]);
