const identifierFields=new Set(['message_id','msg_id','svr_id']);

/** Preserve vendor uint64 identities before JavaScript can round their digits. */
export function parseWeixinJson(text){
 JSON.parse(text);
 const parts=[];let copied=0,index=0;
 while(index<text.length){
  if(text[index]!=='"'){index++;continue;}
  const start=index++;let escaped=false;
  while(index<text.length){const value=text[index++];if(escaped)escaped=false;else if(value==='\\')escaped=true;else if(value==='"')break;}
  const key=JSON.parse(text.slice(start,index));let next=index;
  while(/\s/.test(text[next]??'')&&next<text.length)next++;
  if(text[next]!==':'||!identifierFields.has(key))continue;
  next++;while(/\s/.test(text[next]??'')&&next<text.length)next++;
  const numberStart=next;if(text[next]==='-')next++;
  while(next<text.length&&/[0-9]/.test(text[next]))next++;
  if(next===numberStart||text.slice(numberStart,next)==='-'||/[.eE]/.test(text[next]??''))continue;
  parts.push(text.slice(copied,numberStart),JSON.stringify(text.slice(numberStart,next)));copied=next;index=next;
 }
 parts.push(text.slice(copied));return JSON.parse(parts.join(''));
}
