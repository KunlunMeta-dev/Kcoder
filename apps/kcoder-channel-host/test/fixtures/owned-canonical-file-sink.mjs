// Controlled platform endpoint: actual Native ownership, IPC, stream and Outbox remain production.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {requireValue} from '../../src/errors.mjs';
const card=Buffer.from('{"kind":"document","paragraphs":["OWNED_CHANNEL_FILE_BYTES. Literal source retained."]}');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function ownedCanonicalFileSink({format='card',maxDeliveries=1}={}){
 const originals=new Map();
 const recipient=destination=>requireValue(destination?.platform==='wecom'&&destination.conversationId==='owned-channel-conversation','OWNED_FILE_RECIPIENT_CHANGED');
 return {
  async prepareUpload(file,{deliveryId,destination,signal}){
   signal.throwIfAborted();recipient(destination);
   requireValue(!originals.has(deliveryId)&&originals.size<maxDeliveries,'OWNED_FILE_PREPARATION_REPLAYED');
   requireValue(format==='card'?file.expectedBytes===card.length&&file.sha256===hash(card):format==='docx'&&Number.isSafeInteger(file.expectedBytes)&&file.expectedBytes>=4&&file.filename.endsWith('.docx'),'OWNED_FILE_PREPARATION_CHANGED');
   originals.set(deliveryId,{destination,uploaded:false,sent:false});return null;
  },
  async upload(file,{deliveryId,destination,signal}){
   signal.throwIfAborted();recipient(destination);const original=originals.get(deliveryId);
   requireValue(original&&!original.uploaded&&!original.sent&&isDeepStrictEqual(destination,original.destination),'OWNED_UPLOAD_REPLAYED');
   const parts=[];for await(const part of file.byteStream()){signal.throwIfAborted();parts.push(part);}
   const bytes=Buffer.concat(parts),sha256=hash(bytes);
   requireValue(file.expectedBytes===bytes.length&&file.sha256===sha256&&(format==='card'?bytes.equals(card):bytes.subarray(0,4).equals(Buffer.from([0x50,0x4b,3,4]))),'OWNED_UPLOAD_CONTENT_CHANGED');
   original.uploaded=true;original.handle={mediaId:'owned-actual-upload-'+sha256,bytes:bytes.length,sha256};
   process.stderr.write('OWNED_ACTUAL_CANONICAL_UPLOAD '+JSON.stringify({deliveryId,bytes:bytes.length,sha256})+'\n');return original.handle;
  },
  async sendFile(delivery,handle,{deliveryId,signal}){
   signal.throwIfAborted();recipient(delivery.destination);const original=originals.get(deliveryId);
   requireValue(original?.uploaded&&!original.sent&&isDeepStrictEqual(handle,original.handle)&&isDeepStrictEqual(delivery.destination,original.destination)&&delivery.channelPublication?.phase==='terminal'&&delivery.content?.artifactRef?.kind==='artifact','OWNED_FILE_SEND_CHANGED');
   original.sent=true;
   const receipt={state:'accepted',messageId:'owned-file-receipt-'+deliveryId,bytes:handle.bytes,sha256:handle.sha256,fixtureOnly:true,viewed:false};
   process.stderr.write('OWNED_ACTUAL_CANONICAL_FILE_RECEIPT '+JSON.stringify(receipt)+'\n');return receipt;
  },
 };
}
