import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

test('Windows installer ships real icon and repair script and runs after shortcut setup', async () => {
  const config = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).build;
  assert.equal(config.nsis.include, 'desktop/windows-shell-installer.nsh');
  assert.ok(config.win.extraResources.some(item => item.from === 'desktop/windows-shell' && item.to === 'shell'));
  assert.ok(config.win.extraResources.some(item => item.from.endsWith('/icon.ico') && item.to === 'shell/icon.ico'));
  const hook = await readFile(new URL('./windows-shell-installer.nsh', import.meta.url), 'utf8');
  assert.match(hook, /!macro customInstall/);
  assert.match(hook, /\$newDesktopLink/);
  assert.match(hook, /\$newStartMenuLink/);
  assert.match(hook, /\$0 != 0/);
});

test('combined installer exposes the bundled CLI and cleans PATH only after successful removal', async () => {
  const config = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).build;
  assert.ok(config.win.extraResources.some(item => item.to === 'bin/kcoder.exe'));
  const hook = await readFile(new URL('./windows-shell-installer.nsh', import.meta.url), 'utf8');
  assert.match(hook, /install-cli\.ps1.*-Mode Install -Scope/);
  assert.match(hook, /\$installMode == "all"/);
  const uninstall=hook.split('!macro customUnInstallSection')[1].split('!macroend')[0];
  assert.match(uninstall, /-File "\$PLUGINSDIR\\kcoder-cli-cleanup\.ps1"[^\n]*-Mode Uninstall -Scope/);
  assert.match(hook, /Section "un\.-KCoder CLI PATH"\s+SectionIn RO/);
  const beforeRemoval = hook.split('!macro customUnInstall\n')[1].split('!macroend')[0];
  assert.match(beforeRemoval, /CopyFiles/);
  assert.doesNotMatch(beforeRemoval, /-Mode Uninstall/);
});

test('the installed executable prepares the account before the installer offers to launch', async () => {
  const hook = await readFile(new URL('./windows-shell-installer.nsh', import.meta.url), 'utf8');
  const install = hook.split('!macro customInstall\n')[1].split('!macroend')[0];
  assert.ok(install.includes('ExecWait \'"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" --prepare-windows-startup$kcoderStorageArgs\''));
  assert.equal(hook.split('!macro customUnInstall\n')[1].includes('--prepare-windows-startup'), false);
});

test('NSIS offers optional data/cache choices and passes only explicit changes to the existing entry', async () => {
  const hook = await readFile(new URL('./windows-shell-installer.nsh', import.meta.url), 'utf8');
  assert.match(hook, /!macro customPageAfterChangeDir\s+Page custom kcoderStoragePage kcoderStoragePageLeave/);
  assert.match(hook, /NSD_CreateDirRequest[^\n]*"\$kcoderDataRoot"/);
  assert.match(hook, /NSD_CreateDirRequest[^\n]*"\$kcoderCacheRoot"/);
  for (const option of ['DATA', 'CACHE']) assert.ok(hook.includes(`/KCODER_${option}_ROOT=`));
  const install = hook.split('!macro customInstall\n')[1].split('!macroend')[0];
  for (const [field, flag] of [['Data', 'data'], ['Cache', 'cache']]) {
    assert.ok(install.includes(`\${If} $kcoder${field}Root != ""\n      StrCpy $kcoderStorageArgs '$kcoderStorageArgs --${flag}-root "$kcoder${field}Root\\."'`));
  }
  assert.match(install, /\$\{If\} \$\{Silent\}\s+StrCpy \$kcoderStorageArgs "\$kcoderStorageArgs --storage-install-silent"/);
  assert.doesNotMatch(hook, /kcoder-storage\.json|WriteRegStr[^\n]*(?:DataRoot|CacheRoot)|KCODER_HOME=/);
});

test('all-user and elevated installs reject explicit roots and defer personal startup', async () => {
  const hook = await readFile(new URL('./windows-shell-installer.nsh', import.meta.url), 'utf8');
  const account = hook.split('Function kcoderCheckStorageAccount\n')[1].split('FunctionEnd')[0];
  assert.match(account, /\$installMode == "all"\s+\$\{OrIf\} \$\{UAC_IsInnerInstance\}\s+\$\{OrIf\} \$\{UAC_IsAdmin\}/);
  assert.match(account, /StrCpy \$kcoderStoragePerUser "0"/);
  assert.match(account, /\$kcoderDataRoot != ""\s+\$\{OrIf\} \$kcoderCacheRoot != ""[\s\S]*SetErrorLevel 2\s+Quit/);
  const install = hook.split('!macro customInstall\n')[1].split('!macroend')[0];
  assert.match(install, /Call kcoderCheckStorageAccount\s+\$\{If\} \$kcoderStoragePerUser == "1"[\s\S]*ExecWait[\s\S]*\$\{Else\}\s+DetailPrint "Personal storage choice deferred/);
});

test('silent upgrades abort on active installer processes before close while interactive upgrades confirm', async () => {
  const hook = await readFile(new URL('./windows-shell-installer.nsh', import.meta.url), 'utf8');
  const check = hook.split('!macro customCheckAppRunning\n')[1].split('!macroend')[0];
  const active = check.slice(check.indexOf('${If} $0 == 10'), check.indexOf('-Mode Close'));
  assert.ok(active.indexOf('${If} ${Silent}') >= 0, 'active-process result must branch on silent mode');
  assert.match(active, /KCoder processes are still running\. Close them before an unattended installation\./);
  assert.match(active, /KCoder 进程仍在运行。请关闭后再进行静默安装。/);
  assert.match(active, /SetErrorLevel 2\s+Quit/);
  assert.match(active, /MessageBox MB_OKCANCEL[^\n]*Continuing will interrupt their active tasks/);
  assert.ok(active.indexOf('SetErrorLevel 2') < active.indexOf('MessageBox MB_OKCANCEL'),
    'silent failure must quit before reaching interactive confirmation');
  assert.ok(check.indexOf('-Mode Close') > check.indexOf('MessageBox MB_OKCANCEL'),
    'interactive confirmation must precede the process-close request');
});

test('storage choices compile with the real NSIS compiler in installer and uninstaller contexts', async t => {
  const run = promisify(execFile);
  try { await run('makensis', ['-VERSION']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('makensis unavailable'); return; } throw error; }
  const cache = join(homedir(), '.cache', 'electron-builder');
  const resourceName = (await readdir(cache).catch(() => [])).find(name => name.startsWith('nsis-resources-'));
  if (!resourceName) { t.skip('offline electron-builder UAC plugin unavailable'); return; }
  const resourceRoot = join(cache, resourceName);
  const resourceVersion = (await readdir(resourceRoot)).find(name => name.startsWith('nsis-resources-'));
  if (!resourceVersion) { t.skip('offline electron-builder UAC plugin unavailable'); return; }
  const require = createRequire(new URL('../package.json', import.meta.url));
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const include = join(dirname(builderRequire.resolve('app-builder-lib')), '../templates/nsis/include');
  const root = await mkdtemp(join(tmpdir(), 'owned-nsis-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const uninstaller of [false, true]) {
    const path = join(root, `${uninstaller ? 'uninstaller' : 'installer'}.nsi`);
    const source = `Unicode true
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "MUI2.nsh"
!addincludedir "${include}"
!addplugindir "${join(resourceRoot, resourceVersion, 'plugins/x86-unicode')}"
!define APP_GUID "owned-storage-compile"
!define APP_EXECUTABLE_FILENAME "fixture.exe"
${uninstaller ? '!define BUILD_UNINSTALLER' : ''}
Var installMode
Var PowerShellPath
Var newDesktopLink
Var newStartMenuLink
!include "${fileURLToPath(new URL('./windows-shell-installer.nsh', import.meta.url))}"
Name "Owned storage syntax fixture"
OutFile "${join(root, `${uninstaller ? 'uninstaller' : 'installer'}.exe`)}"
${uninstaller ? '' : '!insertmacro customPageAfterChangeDir'}
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
LangString appCannotBeClosed 1033 "Cannot close owned fixture"
LangString appCannotBeClosed 2052 "Cannot close owned fixture"
${uninstaller ? '' : 'Function .onInit\n!insertmacro customInit\nFunctionEnd'}
Section "install"
${uninstaller ? 'WriteUninstaller "$TEMP\\owned-storage-compile-uninstall.exe"' : '!insertmacro customCheckAppRunning\n!insertmacro customInstall'}
SectionEnd
${uninstaller ? 'Section "un.fixture"\n!insertmacro customCheckAppRunning\n!insertmacro customUnInstall\nSectionEnd\n!insertmacro customUnInstallSection' : ''}
`;
    await writeFile(path, source);
    await run('makensis', ['-NOCD', '-V2', path], { maxBuffer: 1024 * 1024 });
  }
});
