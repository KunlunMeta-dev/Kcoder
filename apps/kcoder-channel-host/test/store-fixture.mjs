import { rmSync } from 'node:fs';
import { ConnectivityStore } from '../src/applications/store.mjs';

/** Unit proof ports do not establish Windows ACL acceptance or a production lease. */
export function createFixtureStore(root,options={}){return ConnectivityStore.create(root,{assertExclusiveLease:()=>true,
 nativeWindowsProof:process.platform==='win32'?()=>true:undefined,...options});}
export function removeFixtureStore(root){rmSync(root,{recursive:true,force:true});rmSync(root+'.binding.json',{force:true});}
