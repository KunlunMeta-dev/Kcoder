import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from './gateway-mobile-web-manifest.mjs';
import { checkClientVersion } from '../../../../scripts/release/client-version.mjs';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output-dir' || !args[1])) throw new Error('Usage: export-gateway-web.mjs [--output-dir directory]');
const dist = resolve(mobile, args[1] ?? 'dist');
await checkClientVersion();
// Use Expo's official baseUrl transform for Router, Metro chunks and static assets.
const child = spawn(process.execPath, [resolve(mobile, 'node_modules/expo/bin/cli'), 'export', '--platform', 'web', '--output-dir', dist], {
  cwd: mobile, stdio: 'inherit', env: { ...process.env, KCODER_STUDIO_MOBILE_WEB_DEPLOY: '1' },
});
const exit = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code, signal) => accept({ code, signal })); });
if (exit.code !== 0) throw new Error(`Mobile Web export failed (${exit.signal ?? exit.code})`);
const manifest = await buildGatewayMobileWebManifest(dist);
await writeGatewayMobileWebManifest(dist, manifest);
console.log(`Gateway Mobile Web build ready (${manifest.files.length} resources)`);
