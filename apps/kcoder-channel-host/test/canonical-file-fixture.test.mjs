import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ownedCanonicalFileSink} from './fixtures/owned-canonical-file-sink.mjs';
const bytes=Buffer.from('{"kind":"document","paragraphs":["OWNED_CHANNEL_FILE_BYTES. Literal source retained."]}');
test('controlled canonical file endpoint compares exact original values across reordered private IPC object keys',async()=>{
 const sink=ownedCanonicalFileSink(),signal=new AbortController().signal;
 const destination={platform:'wecom',conversationId:'owned-channel-conversation'},deliveryId='original-file-child';
 const file={filename:'card.json',mediaType:'application/json',expectedBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),byteStream:()=> (async function*(){yield bytes.subarray(0,13);yield bytes.subarray(13);})()};
 await sink.prepareUpload(file,{deliveryId,destination,signal});
 const handle=await sink.upload(file,{deliveryId,destination,signal}),roundTrip=Object.fromEntries(Object.entries(handle).sort());
 assert.notEqual(JSON.stringify(roundTrip),JSON.stringify(handle));
 const delivery={destination:{conversationId:destination.conversationId,platform:destination.platform},channelPublication:{ingressId:'original-ingress',phase:'terminal'},content:{artifactRef:{kind:'artifact',id:'native-card',revision:'1'}}};
 const receipt=await sink.sendFile(delivery,roundTrip,{deliveryId,signal});
 assert.equal(receipt.state,'accepted');assert.equal(receipt.bytes,bytes.length);assert.equal(receipt.sha256,file.sha256);assert.equal(receipt.viewed,false);
 await assert.rejects(sink.sendFile(delivery,roundTrip,{deliveryId,signal}),/OWNED_FILE_SEND_CHANGED/);
 await assert.rejects(sink.upload(file,{deliveryId,destination,signal}),/OWNED_UPLOAD_REPLAYED/);
});
