import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot, waitFor } from './run-context.mjs';

export async function startWindowsRemoteStudio(context, { target, windowsBinary, installation, node, ssh, extraPorts = [] }) {
  if (!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(target || '')) throw new Error('Invalid explicit Windows SSH target');
  if (!windowsBinary || !ssh || !Number.isInteger(ssh.port) || ssh.port < 1 || ssh.port > 65535 || extraPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid explicit Windows binary or tunnel ports');
  for (const value of [installation, node]) if (typeof value !== 'string' || !value || value.includes("'")) throw new Error('Invalid explicit Windows path');
  let sequence=0;
  const writeStateFile=async(name,value)=>{const path=context.pathInState(name);await writeFile(path,value,{mode:0o600});return path;};
  const execute=(command,args,timeout=120000)=>new Promise((done,fail)=>{
    const label=`win-remote-oauth-${++sequence}`;const child=context.spawnOwned(label,command,args);let stdout='';
    const timer=setTimeout(()=>{void context.stopOwned(label);fail(new Error('Owned Windows command timed out'));},timeout);
    child.stdout.on('data',data=>{stdout+=data;if(stdout.length>2*1024*1024)child.kill();});
    child.once('error',error=>{clearTimeout(timer);fail(error);});
    child.once('close',code=>{clearTimeout(timer);code===0?done(stdout):fail(new Error(`Owned Windows command failed (${code}): ${context.redactText(stdout).slice(-2000)}`));});
  });
  const ps=script=>execute('ssh',['-o','BatchMode=yes','-S','none',target,'powershell','-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from("$ProgressPreference='SilentlyContinue';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new();"+script,'utf16le').toString('base64')]);
  const name='kcoder-remote-studio-'+randomUUID();
  const directory=JSON.parse((await ps(`$p=Join-Path ([IO.Path]::GetTempPath()) '${name}';[IO.Directory]::CreateDirectory($p)|Out-Null;ConvertTo-Json -InputObject $p`)).trim());
  assert.ok(directory.endsWith(name)&&!directory.includes("'"));
  context.addCleanup('remove owned Windows directory',()=>promisify(execFile)('ssh',['-o','BatchMode=yes','-S','none',target,'powershell','-NoProfile','-EncodedCommand',Buffer.from(`[IO.Directory]::Delete('${directory}',$true);if([IO.Directory]::Exists('${directory}')){throw 'Remote cleanup failed'}`,'utf16le').toString('base64')],{timeout:15000}));
  const dest=directory.replaceAll('\\','/');
  const upload=(source,destination)=>execute('scp',['-o','BatchMode=yes','-o','ControlPath=none',source,`${target}:${dest}/${destination}`]);
  const tunnel=context.spawnOwned('windows-loopback-forwards','ssh',['-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-S','none','-N','-R',`127.0.0.1:${ssh.port}:127.0.0.1:${ssh.port}`,...extraPorts.flatMap(port => ['-R', `127.0.0.1:${port}:127.0.0.1:${port}`]),target]);
  await waitFor(async()=>{if(tunnel.exitCode!==null)throw new Error('Reverse tunnel exited');return ps(`$c=[Net.Sockets.TcpClient]::new();try{$c.Connect('127.0.0.1',${ssh.port});'ready'}finally{$c.Dispose()}`).then(value=>value.includes('ready'),()=>false);},15000,'Windows loopback SSH forward');
  const keyPath=directory+'\\client-key';
  await upload(resolve(ssh.root,'client-key'),'client-key');
  await ps(`icacls '${keyPath}' /inheritance:r /grant:r "$($env:USERNAME):R"|Out-Null;[IO.Directory]::CreateDirectory('${directory}\\ssh-bin')|Out-Null`);
  const sshConfig=await writeStateFile('windows-ssh-config',`Host *\n  IdentityFile "${keyPath.replaceAll('\\','/')}"\n  IdentitiesOnly yes\n  UserKnownHostsFile "${dest}/known_hosts"\n  StrictHostKeyChecking accept-new\n`);
  await upload(sshConfig,'ssh-config');
  const shim=await writeStateFile('ssh-shim.c',`#include <process.h>\n#include <stdlib.h>\nint main(int argc,char **argv){char **args=calloc(argc+3,sizeof(char*));args[0]="C:\\\\Windows\\\\System32\\\\OpenSSH\\\\ssh.exe";args[1]="-F";args[2]=${JSON.stringify(directory+'\\ssh-config')};for(int i=1;i<argc;i++)args[i+2]=argv[i];int result=_spawnv(_P_WAIT,args[0],(const char*const*)args);free(args);return result<0?127:result;}\n`);
  const shimBinary=context.pathInState('ssh.exe');await execute('x86_64-w64-mingw32-gcc',[shim,'-o',shimBinary]);await upload(shimBinary,'ssh-bin/ssh.exe');
  const archive=context.pathInState('overlay.tgz');await execute('tar',['-czf',archive,'-C',resolve(repoRoot,'apps/kcoder-studio'),'renderer/dist','dev-server.mjs','src','-C',repoRoot,'logo/logo.png']);
  await upload(archive,'overlay.tgz');await upload(resolve(windowsBinary),'kcoder.exe');await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/windows-studio-ui-probe.cjs'),'probe.cjs');
  await ps(`[IO.Directory]::CreateDirectory('${directory}\\overlay')|Out-Null;& tar -xf '${directory}\\overlay.tgz' -C '${directory}\\overlay';if($LASTEXITCODE -ne 0){throw 'Overlay extraction failed'}`);
  return {
    async run(mode, input, screenshots = []) {
      if (!['remote-oauth', 'remote-models'].includes(mode)) throw new Error('Unsupported owned Windows probe');
      const inputPath = await context.writeStateJson(`${mode}-input.json`, input);
      await upload(inputPath, `${mode}-input.json`);
      let result;
      try { result = JSON.parse((await ps(`& '${node}' '${directory}\\probe.cjs' '${directory}\\kcoder.exe' '${installation}' '${directory}\\overlay' '${directory}' --${mode}`)).trim()); }
      finally {
        for (const file of [...screenshots, 'windows-failure.png']) {
          if (!/^[a-z0-9-]+\.png$/.test(file)) throw new Error('Invalid screenshot leaf');
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
