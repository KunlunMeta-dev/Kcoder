import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runE2E, requireExecutable } from '../../harness/run-context.mjs';

// Wine is only a compatibility smoke check for packaged native executables. This
// never claims native Windows/Electron validation or installs into a real profile.
await runE2E(import.meta.url, {
  testId: 'packaged-windows-cli-pdf-wine-isolated-prefix', tier: 'manual-live',
  modelPolicy: 'model-independent Windows PE CLI startup and bundled PDF extraction under Wine',
}, async context => {
  if (process.platform !== 'linux' || !process.env.KCODER_E2E_PACKAGED_DIR) {
    throw new Error('UNMET_PREREQUISITE: Linux Wine and explicit KCODER_E2E_PACKAGED_DIR are required');
  }
  const wine = await requireExecutable('/usr/bin/wine', 'Wine');
  const wineServer = await requireExecutable('/usr/bin/wineserver', 'Wine server');
  const root = resolve(process.env.KCODER_E2E_PACKAGED_DIR);
  const cli = await requireExecutable(resolve(root, 'resources/bin/kcoder.exe'), 'packaged Windows CLI');
  const pdf = await requireExecutable(resolve(root, 'resources/bin/pdf/pdftotext.exe'), 'bundled Windows PDF extractor');
  const prefix = context.pathInState('wine-prefix');
  const workspace = context.pathInState('workspace');
  await Promise.all([mkdir(prefix), mkdir(workspace)]);
  const env = context.isolatedEnvironment({ WINEPREFIX: prefix, WINEARCH: 'win64',
    // Wine converts Unix argv using the host locale before Windows receives it.
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    WINEDEBUG: '-all', WINEDLLOVERRIDES: 'mscoree,mshtml,winemenubuilder.exe=d',
    KCODER_CONFIG_DIR: windowsPath(context.pathInState('config')), });
  // Foreground server is registered before Wine can create a detached daemon.
  context.spawnOwned('owned-wine-server', wineServer, ['-f', '-p'], { env, cwd: workspace });
  const execute = async (label, command, args, timeout = 90000) => {
    const child = context.spawnOwned(label, command, args, { env, cwd: workspace });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-65536); });
    const code = await new Promise((done, reject) => {
      const timer = setTimeout(() => { void context.stopOwned(label); reject(new Error(`${label} timed out`)); }, timeout);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      // Wine startup services may retain inherited pipes after this command exits.
      // Await the owned command, not pipe closure from those separate services.
      child.once('exit', code => { clearTimeout(timer); setImmediate(() => done(code)); });
    });
    assert.equal(code, 0, `${label} failed; inspect owned logs`);
    return output;
  };
  try {
    const version = (await execute('windows-cli-version', wine, [cli, '--version'])).trim();
    assert.match(version, /kcoder\s+\d+\.\d+/i);
    const marker = 'KCODER_WINDOWS_BUNDLED_PDF';
    for (const [index, name] of ['PDF with spaces', 'PDF 中文目录'].entries()) {
      const directory = resolve(workspace, name); await mkdir(directory);
      const input = resolve(directory, 'source.pdf'); await writeFile(input, fixturePdf(marker));
      const extracted = await execute(`windows-pdf-${index}`, wine, [pdf, '-enc', 'UTF-8', windowsPath(input), '-']);
      assert.ok(extracted.includes(marker), `bundled native PDF extraction lost fixture text for ${name}`);
    }
    return { platform: 'wine-on-linux', nativeWindowsVerified: false, electronUiVerified: false,
      cliVersion: version, bundledPdf: true, pathsWithSpaces: true, pathsWithChinese: true };
  } finally {
    // Stop only services associated with this run's exact Wine prefix while the
    // context is active; ordinary RunContext cleanup then reaps all owned groups.
    await execute('stop-owned-wine-services', wineServer, ['-k'], 15000);
    await execute('wait-owned-wine-services', wineServer, ['-w'], 15000);
  }
});

function windowsPath(path) { return `Z:${path.replaceAll('/', '\\')}`; }
function fixturePdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET\n`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let source = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return source + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
