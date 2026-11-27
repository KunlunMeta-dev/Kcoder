// Actual owned-process regression fixture, copied into an isolated test package.
import { closeSync, writeFileSync } from 'node:fs';
writeFileSync(new URL('../pid', import.meta.url), String(process.pid), { mode: 0o600 });
process.stdin.resume();
closeSync(1);
setInterval(() => {}, 1000);
