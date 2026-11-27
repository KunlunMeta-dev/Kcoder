import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { httpsUrl } from './validation.mjs';
import { boundedJson } from './transport.mjs';
import { ChannelError,requireValue } from './errors.mjs';

// AES-ECB PKCS#7 adds one block even for a block-aligned 100 MiB source.
const MAX_ENCRYPTED_UPLOAD_BYTES=100*1024*1024+16;
function uploadSignal(owner, bytes) {
  const timeoutMs = Math.min(300000, 30000 + Math.ceil(bytes / (256 * 1024)) * 1000);
  const deadline = AbortSignal.timeout(timeoutMs);
  return owner ? AbortSignal.any([owner, deadline]) : deadline;
}
function uploadFailure(error){
  if(error instanceof ChannelError){error.externalOutcome??='unknown';return error;}
  const uncertain=new ChannelError('PLATFORM_UPLOAD_UNCONFIRMED','reconcile_original');uncertain.externalOutcome='unknown';Object.defineProperty(uncertain,'cause',{value:error});return uncertain;
}

function rejectedStatus(response){
  if(response.ok)return;
  const error=new ChannelError(response.status===401||response.status===403?'PLATFORM_AUTHORIZATION_FAILED':response.status===429?'PLATFORM_RATE_LIMIT':'PLATFORM_UPLOAD_REJECTED');
  error.externalOutcome=response.status>=400&&response.status<500?'failed':'unknown';throw error;
}
export async function platformMultipart(url,{file,fieldName='file',fields={},headers={},signal,hosts,fetchImpl=fetch}){
  const target=httpsUrl(url,{allowedHosts:hosts});
  requireValue(file&&typeof file.filename==='string'&&!/[\r\n"\\]/.test(file.filename)&&typeof file.mediaType==='string'&&/^[\w.+-]+\/[\w.+-]+$/.test(file.mediaType)&&Number.isSafeInteger(file.expectedBytes)&&file.expectedBytes>=0&&typeof file.byteStream==='function','INVALID_UPLOAD_FILE');
  requireValue(/^[a-z_]+$/.test(fieldName),'INVALID_UPLOAD_FIELD');
  const boundary='kcoder-'+randomBytes(20).toString('hex'),head=[];
  for(const[key,value]of Object.entries(fields)){requireValue(/^[a-z_]+$/.test(key)&&typeof value==='string'&&!/[\r\n]/.test(value),'INVALID_UPLOAD_FIELD');head.push('--'+boundary+'\r\nContent-Disposition: form-data; name="'+key+'"\r\n\r\n'+value+'\r\n');}
  head.push('--'+boundary+'\r\nContent-Disposition: form-data; name="'+fieldName+'"; filename="'+file.filename+'"\r\nContent-Type: '+file.mediaType+'\r\n\r\n');
  const prefix=Buffer.from(head.join('')),suffix=Buffer.from('\r\n--'+boundary+'--\r\n');
  const requestSignal=uploadSignal(signal,file.expectedBytes);let response;
  async function* body(){
    yield prefix;let bytes=0;
    for await(const chunk of file.byteStream()){requestSignal.throwIfAborted();bytes+=chunk.length;requireValue(bytes<=file.expectedBytes,'UPLOAD_SIZE_MISMATCH');yield chunk;}
    requireValue(bytes===file.expectedBytes,'UPLOAD_SIZE_MISMATCH');yield suffix;
  }
  const stream=Readable.from(body());
  try{
    response=await fetchImpl(target,{method:'POST',headers:{...headers,'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':String(prefix.length+file.expectedBytes+suffix.length)},body:stream,duplex:'half',redirect:'error',signal:requestSignal});
    if(!response.ok){await response.body?.cancel().catch(()=>{});rejectedStatus(response);}
    const result=await boundedJson(response);await finished(stream,{signal:requestSignal,cleanup:true});return result;
  }catch(error){throw uploadFailure(error);}
  finally{stream.destroy();await response?.body?.cancel().catch(()=>{});}
}
export async function platformBinaryUpload(url,{byteStream,expectedBytes,signal,hosts,fetchImpl=fetch}){
  const target=httpsUrl(url,{allowedHosts:hosts});requireValue(Number.isSafeInteger(expectedBytes)&&expectedBytes>0&&expectedBytes<=MAX_ENCRYPTED_UPLOAD_BYTES,'INVALID_UPLOAD_SIZE');
  requireValue(byteStream&&typeof byteStream[Symbol.asyncIterator]==='function','INVALID_UPLOAD_FILE');
  const requestSignal=uploadSignal(signal,expectedBytes);let response;
  async function* body(){let bytes=0;for await(const chunk of byteStream){requestSignal.throwIfAborted();bytes+=chunk.length;requireValue(bytes<=expectedBytes,'UPLOAD_SIZE_MISMATCH');yield chunk;}requireValue(bytes===expectedBytes,'UPLOAD_SIZE_MISMATCH');}
  const stream=Readable.from(body());
  try{
    response=await fetchImpl(target,{method:'POST',headers:{'Content-Type':'application/octet-stream','Content-Length':String(expectedBytes)},body:stream,duplex:'half',redirect:'error',signal:requestSignal});
    rejectedStatus(response);requireValue(response.status===200,'PLATFORM_UPLOAD_REJECTED');await finished(stream,{signal:requestSignal,cleanup:true});
    const value=response.headers.get('x-encrypted-param');requireValue(typeof value==='string'&&value.length>0&&value.length<=16384,'PLATFORM_UPLOAD_RECEIPT_MISSING');
    return {encryptedParam:value};
  }catch(error){throw uploadFailure(error);}
  finally{stream.destroy();await response?.body?.cancel().catch(()=>{});}
}
