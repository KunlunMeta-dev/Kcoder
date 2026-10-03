import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  assert.match(hook, /!macro customUnInstallSection[\s\S]*-Mode Uninstall -Scope/);
  assert.match(hook, /Section "un\.-KCoder CLI PATH"\s+SectionIn RO/);
  const beforeRemoval = hook.split('!macro customUnInstall\n')[1].split('!macroend')[0];
  assert.match(beforeRemoval, /CopyFiles/);
  assert.doesNotMatch(beforeRemoval, /-Mode Uninstall/);
});
