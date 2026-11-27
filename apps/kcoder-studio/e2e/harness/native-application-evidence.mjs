import {readFile} from 'node:fs/promises';

export async function originalApplicationFixtureExited(record,reader=readFile){
 if(!Number.isSafeInteger(record.pid)||record.pid<=0||typeof record.startTicks!=='string'||!/^[0-9]+$/.test(record.startTicks))throw new Error('Exact owned fixture identity required');
 try{
  const raw=await reader(`/proc/${record.pid}/stat`,'utf8');
  const delimiter=raw.lastIndexOf(') ');if(delimiter<0)throw new Error('Original fixture process identity unreadable');
  const current=raw.slice(delimiter+2).split(' ')[19];
  if(!/^[0-9]+$/.test(current??''))throw new Error('Original fixture process identity unreadable');
  return current!==record.startTicks;
 }catch(error){if(error.code==='ENOENT')return true;throw error;}
}
