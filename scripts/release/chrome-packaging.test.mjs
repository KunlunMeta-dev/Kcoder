import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const template = join(repository, 'scripts/install/installers/kcoder-windows-installer.nsi');

test('optional NSIS browser resources require managed ownership before replacement and uninstall', async () => {
  const source = await readFile(template, 'utf8');
  assert.match(source, /!ifndef CHROME_DIRECTORY/);
  assert.match(source, /File \/r "\$\{CHROME_DIRECTORY\}\\\*"/);
  const install = source.slice(source.indexOf('commit_main:'), source.indexOf('install_rollback:'));
  const uninstall = source.slice(source.indexOf('Section "Uninstall"'));
  for (const section of [install, uninstall]) {
    assert.match(section, /chrome\\\.kcoder-chrome\.json/);
    assert.match(section, /GetFileAttributesW/);
    assert.match(section, /0x410/);
  }
  assert.match(source, /Rename "\$TransactionDir\\backup\\chrome" "\$INSTDIR\\chrome"/);
});

test('NSIS compiles with and without the optional browser tree using isolated non-executable fixtures', async context => {
  try { await run('makensis', ['-VERSION']); }
  catch { context.skip('makensis is not available for offline macro compilation'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-chrome-nsis-'));
  try {
    const cli = join(directory, 'fixture.exe'), chrome = join(directory, 'chrome');
    await writeFile(cli, 'non-executable packaging fixture');
    await mkdir(join(chrome, 'chrome-win64'), { recursive: true });
    await writeFile(join(chrome, 'chrome-win64/chrome.exe'), 'non-executable browser fixture');
    await writeFile(join(chrome, 'chrome-win64/ABOUT'), 'public attribution fixture');
    await writeFile(join(chrome, '.kcoder-chrome.json'), '{}');
    for (const included of [false, true]) {
      const output = join(directory, `fixture-${included}.exe`);
      await run('makensis', ['-NOCD', '-V2', '-DVERSION=0.0.0', '-DVERSION4=0.0.0.0',
        `-DCLI_BINARY=${cli}`, `-DSUPERVISOR_BINARY=${cli}`, `-DOUT_FILE=${output}`,
        ...(included ? [`-DCHROME_DIRECTORY=${chrome}`] : []), template], { timeout: 30000 });
      assert.ok((await stat(output)).size > 0);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
