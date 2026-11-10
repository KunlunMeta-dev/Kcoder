import { rmSync } from 'node:fs';
import { ConnectivityStore } from '../src/applications/store.mjs';

/** Component fixtures own their temporary namespace; this is not a production lease provider. */
export function createFixtureStore(root,options={}){return ConnectivityStore.create(root,{assertExclusiveLease:()=>true,...options});}
export function removeFixtureStore(root){rmSync(root,{recursive:true,force:true});rmSync(root+'.binding.json',{force:true});}
