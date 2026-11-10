import { createHash } from 'node:crypto';
import { mediaBufferBudget } from '../media-budget.mjs';
import { requireValue } from '../errors.mjs';

/** Reserve copy/Base64 peak before allocating SDK buffers. The caller releases after its send. */
export async function readUploadBuffer(file,{maxBytes=50*1024*1024,copies=3,signal}={}){
  requireValue(Number.isSafeInteger(file?.expectedBytes)&&file.expectedBytes>0&&file.expectedBytes<=maxBytes,'PLATFORM_FILE_TOO_LARGE','explicit_user_decision');
  const reservation=mediaBufferBudget.reserve(file.expectedBytes*copies);let data;
  try{
    data=Buffer.alloc(file.expectedBytes);const digest=createHash('sha256');let offset=0;
    for await(const chunk of file.byteStream()){signal?.throwIfAborted();requireValue(offset+chunk.length<=data.length,'UPLOAD_SIZE_MISMATCH');data.set(chunk,offset);digest.update(chunk);offset+=chunk.length;}
    requireValue(offset===data.length&&digest.digest('hex')===file.sha256,'UPLOAD_INTEGRITY_FAILED');
    return {data,dispose:()=>{data.fill(0);reservation.release();}};
  }catch(error){data?.fill(0);reservation.release();throw error;}
}
