// Create the same current-user-only files as the installed Native settings writer.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
module.exports=function secureProbeConfiguration(profile,root){
  if(!fs.realpathSync(profile).toLowerCase().startsWith(fs.realpathSync(root).toLowerCase()+path.sep))throw Error('Configuration is outside the owned probe root');
  const sid=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value'],{windowsHide:true,encoding:'utf8',timeout:10000});
  if(sid.status!==0||!/^S-1-[0-9-]+$/.test(sid.stdout.trim()))throw Error('Actual probe SID unavailable');
  for(const leaf of ['settings.json','credentials.json']){
    const file=path.join(profile,leaf),info=fs.lstatSync(file);
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw Error('Owned configuration file required');
    const secured=spawnSync('icacls.exe',[file,'/inheritance:r','/grant:r',`*${sid.stdout.trim()}:F`],{windowsHide:true,encoding:'utf8',timeout:10000});
    if(secured.status!==0)throw Error('Owned configuration ACL setup failed');
  }
};
