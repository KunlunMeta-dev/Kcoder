import { windowsSshInvocation } from './windows-ssh-auth.mjs';
import { ownedCreationScript, ownedCleanupScript } from './windows-package-probe.mjs';
import { runInteractiveWindowsProbe } from './windows-interactive-probe.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot, waitFor } from './run-context.mjs';

export async function startWindowsRemoteStudio(context, { target, windowsBinary, installation, node, ssh, extraPorts = [], localOnly = false, parent, candidateBundle }) {
  if (!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(target || '')) throw new Error('Invalid explicit Windows SSH target');
  if (!windowsBinary || (!localOnly && (!ssh || !Number.isInteger(ssh.port) || ssh.port < 1 || ssh.port > 65535)) || extraPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid explicit Windows binary or tunnel ports');
  for (const value of [installation, node, ...(parent === undefined ? [] : [parent])]) if (typeof value !== 'string' || !value || value.includes("'")) throw new Error('Invalid explicit Windows path');
  let sequence=0;
  const writeStateFile=async(name,value)=>{const path=context.pathInState(name);await writeFile(path,value,{mode:0o600});return path;};
  const execute=(command,args,timeout=120000,input)=>new Promise((done,fail)=>{
    const label=`win-remote-oauth-${++sequence}`;const spec=['ssh','scp'].includes(command)?windowsSshInvocation(context,command,args,target):{command,args,options:{}};const child=context.spawnOwned(label,spec.command,spec.args,{...spec.options,stdin:input===undefined?'ignore':'pipe'});let stdout='';
    const timer=setTimeout(()=>{void context.stopOwned(label);fail(new Error('Owned Windows command timed out'));},timeout);
    child.stdout.on('data',data=>{stdout+=data;if(stdout.length>2*1024*1024)child.kill();});
    if(input!==undefined)child.stdin.write(input);
    child.once('error',error=>{clearTimeout(timer);fail(error);});
    child.once('close',code=>{clearTimeout(timer);code===0?done(stdout):fail(new Error(`Owned Windows command failed (${code}): ${context.redactText(stdout).slice(-2000)}`));});
  });
  const ps=(script,timeout,input)=>execute('ssh',['-o','BatchMode=yes','-S','none',target,'powershell','-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new();"+script,'utf16le').toString('base64')],timeout,input);
  const owner=randomUUID();
  const name='kcoder-package-'+owner;
  const create = parent ? ownedCreationScript(parent, owner) : `$parent=[IO.Path]::GetTempPath();${ownedCreationScript('__UI_PARENT__',owner).replace("$parent='__UI_PARENT__';",'')}`;
  const directory=JSON.parse((await ps(create)).trim());
  assert.ok(directory.endsWith(name)&&!directory.includes("'"));
  const cleanupPs = async script => {
    const spec=windowsSshInvocation(context,'ssh',['-o','BatchMode=yes','-S','none',target,'powershell','-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],target);
    return (await promisify(execFile)(spec.command,spec.args,{...spec.options,timeout:30000})).stdout;
  };
  const cleanupEvidence=context.pathInArtifacts('windows-ui-cleanup.json');
  context.addCleanup('remove owned Windows directory',async()=>{
    const receipt=JSON.parse((await cleanupPs(ownedCleanupScript(directory,owner,'ui-wrapper.mjs'))).trim());
    await writeFile(cleanupEvidence,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});assert.equal(receipt.cleaned,true);
  });
  const dest=directory.replaceAll('\\','/');
  const upload=(source,destination)=>execute('scp',['-o','BatchMode=yes','-o','ControlPath=none',source,`${target}:${dest}/${destination}`]);
  if (candidateBundle) {
    for (const [source, leaf] of [['kcoder-studio.exe','candidate-studio.exe'],['resources/app.asar','candidate-app.asar'],['resources/bin/kcoder-native-image.node','candidate-native-image.node']])
      await upload(resolve(candidateBundle,source),leaf);
  }
  if (!localOnly) {
  const tunnelSpec=windowsSshInvocation(context,'ssh',['-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-S','none','-N','-R',`127.0.0.1:${ssh.port}:127.0.0.1:${ssh.port}`,...extraPorts.flatMap(port => ['-R', `127.0.0.1:${port}:127.0.0.1:${port}`]),target],target);
  const tunnel=context.spawnOwned('windows-loopback-forwards',tunnelSpec.command,tunnelSpec.args,tunnelSpec.options);
  await waitFor(async()=>{if(tunnel.exitCode!==null)throw new Error('Reverse tunnel exited');return ps(`$c=[Net.Sockets.TcpClient]::new();try{$c.Connect('127.0.0.1',${ssh.port});'ready'}finally{$c.Dispose()}`).then(value=>value.includes('ready'),()=>false);},15000,'Windows loopback SSH forward');
  const keyPath=directory+'\\client-key';
  await upload(resolve(ssh.root,'client-key'),'client-key');
  await ps(`icacls '${keyPath}' /inheritance:r /grant:r "$($env:USERNAME):R"|Out-Null;[IO.Directory]::CreateDirectory('${directory}\\ssh-bin')|Out-Null`);
  const sshConfig=await writeStateFile('windows-ssh-config',`Host *\n  IdentityFile "${keyPath.replaceAll('\\','/')}"\n  IdentitiesOnly yes\n  UserKnownHostsFile "${dest}/known_hosts"\n  StrictHostKeyChecking accept-new\n`);
  await upload(sshConfig,'ssh-config');
  const shim=await writeStateFile('ssh-shim.c',`#include <process.h>\n#include <stdlib.h>\nint main(int argc,char **argv){char **args=calloc(argc+3,sizeof(char*));args[0]="C:\\\\Windows\\\\System32\\\\OpenSSH\\\\ssh.exe";args[1]="-F";args[2]=${JSON.stringify(directory+'\\ssh-config')};for(int i=1;i<argc;i++)args[i+2]=argv[i];int result=_spawnv(_P_WAIT,args[0],(const char*const*)args);free(args);return result<0?127:result;}\n`);
  const shimBinary=context.pathInState('ssh.exe');await execute('x86_64-w64-mingw32-gcc',[shim,'-o',shimBinary]);await upload(shimBinary,'ssh-bin/ssh.exe');
  }
  const archive=context.pathInState('overlay.tgz');
  const rendererArgs=candidateBundle
    ? ['--transform=s|^renderer-dist|renderer/dist|','-C',resolve(candidateBundle,'resources'),'renderer-dist']
    : ['-C',resolve(repoRoot,'apps/kcoder-studio'),'renderer/dist'];
  await execute('tar',['-czf',archive,...rendererArgs,'-C',resolve(repoRoot,'apps/kcoder-studio'),'dev-server.mjs','src','shared','-C',repoRoot,'logo/logo.png']);
  await upload(archive,'overlay.tgz');await upload(resolve(windowsBinary),'kcoder.exe');await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-studio-ui-probe.cjs'),'probe.cjs');
  for(const [source,leaf] of [['windows-migration-ui.cjs','windows-migration-ui.cjs'],['windows-ui-probe-wrapper.mjs','ui-wrapper.mjs'],['owned-process.mjs','owned-process.mjs'],['windows-cdp-document.cjs','windows-cdp-document.cjs'],['windows-gateway-startup-records.cjs','windows-gateway-startup-records.cjs']])
    await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness',source),leaf);
  const migrationLauncher=context.pathInState('migration-cli-env.exe');
  await execute('x86_64-w64-mingw32-gcc',['-municode',resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-migration-cli-env.c'),'-o',migrationLauncher]);
  await upload(migrationLauncher,'migration-cli-env.exe');
  await ps(`[IO.Directory]::CreateDirectory('${directory}\\overlay')|Out-Null;& tar -xf '${directory}\\overlay.tgz' -C '${directory}\\overlay';if($LASTEXITCODE -ne 0){throw 'Overlay extraction failed'}`);
  return {
    async runInteractive(flags) {
      await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-studio-ui-probe.cjs'),'studio-ui-probe.cjs');
      if (flags.includes('--stdio-only')) await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-task-host-stdio.cjs'),'studio-ui-probe.cjs');
      if (flags.includes('--task-host')) await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-task-host-cleanup.ps1'),'windows-task-host-cleanup.ps1');
      if (flags.includes('--task-host')) await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-probe-config.cjs'),'windows-probe-config.cjs');
      let result;
      try { result=await runInteractiveWindowsProbe(context,{ps,cleanupPs,upload,directory,node,installation,flags}); }
      finally {
        for (const file of ['windows-failure.png', 'windows-task-host.png', 'windows-history-dom.json', 'windows-stage.json', 'interactive-stderr.txt', 'interactive-result.json']) {
          if ((await ps(`Test-Path -LiteralPath '${directory}\\${file}'`)).trim() === 'True')
            await execute('scp', ['-o', 'BatchMode=yes', '-o', 'ControlPath=none', `${target}:${dest}/${file}`, context.pathInArtifacts(file)]);
        }
      }
      await context.writeArtifactJson('windows-interactive-result.json',result);
      assert.equal(result.cleaned,true);
      assert.equal(result.result?.passed,true,result.result?.error);
      return result.result;
    },
    async run(mode, input, screenshots = []) {
      if (!['remote-oauth', 'remote-models', 'migration'].includes(mode)) throw new Error('Unsupported owned Windows probe');
      const inputPath = await context.writeStateJson(`${mode}-input.json`, input);
      await upload(inputPath, `${mode}-input.json`);
      let result;
      const wrapperInput=await context.writeStateJson('ui-wrapper-input.json',{directory,owner,node,installation,mode});
      await upload(wrapperInput,'ui-wrapper-input.json');
      try { result = JSON.parse((await ps(`& '${node}' '${directory}\\ui-wrapper.mjs' '${directory}\\ui-wrapper-input.json';exit $LASTEXITCODE`,240000,JSON.stringify({owner})+'\n')).trim()); }
      finally {
        for (const file of [...screenshots, 'windows-failure.png','windows-migration-progress.json']) {
          if (!/^[a-z0-9-]+\.(png|json)$/.test(file)) throw new Error('Invalid screenshot leaf');
          if ((await ps(`Test-Path -LiteralPath '${directory}\\${file}'`)).trim() === 'True')
            await execute('scp', ['-o', 'BatchMode=yes', '-o', 'ControlPath=none', `${target}:${dest}/${file}`, context.pathInArtifacts(file)]);
        }
      }
      await context.writeArtifactJson('windows-result.json', result);
      assert.equal(result.cleaned, true); assert.equal(result.result?.passed, true, result.result?.error);
      return result.result;
    },
  };
}
