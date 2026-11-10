import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { StreamTickets,privateTicketSource } from '../src/stream-tickets.mjs';
function source(data){return {filename:'fixture.bin',mediaType:'application/octet-stream',expectedBytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),byteStream:(async function*(){yield data;})()};}
test('private stream tickets split bytes and reconcile the same original chunk without advancing twice',async()=>{
 const tickets=new StreamTickets(),data=Buffer.alloc(130000,9),ticket=await tickets.open('owner',source(data));
 const first=await tickets.read('owner',ticket.streamId,0);assert.equal(Buffer.from(first.contentBase64,'base64').length,65536);assert.deepEqual(await tickets.read('owner',ticket.streamId,0),first);
 const second=await tickets.read('owner',ticket.streamId,1);assert.equal(Buffer.from(second.contentBase64,'base64').length,64464);
 const done=await tickets.read('owner',ticket.streamId,2);assert.equal(done.done,true);assert.equal(done.bytes,data.length);await tickets.close('owner',ticket.streamId);assert.equal(tickets.reserved,0);
});
test('peer scope cannot read or close another private byte ticket',async()=>{
 const tickets=new StreamTickets(),ticket=await tickets.open('owner',source(Buffer.from('private')));
 await assert.rejects(()=>tickets.read('peer',ticket.streamId,0),/WORKER_STREAM_NOT_FOUND/);await assert.rejects(()=>tickets.close('peer',ticket.streamId),/WORKER_STREAM_NOT_FOUND/);await tickets.closeAll();
});
test('private ticket client checks native byte count/hash and returns no filesystem path',async()=>{
 const tickets=new StreamTickets(),data=Buffer.from('original bytes'),ticket=await tickets.open('owner',source(data));
 const client=privateTicketSource((method,payload)=>method==='read'?tickets.read(payload.owner,payload.streamId,payload.index):tickets.close(payload.owner,payload.streamId),{owner:'owner',ticket});
 const parts=[];for await(const part of client.byteStream)parts.push(part);assert.deepEqual(Buffer.concat(parts),data);assert.equal(client.path,undefined);assert.equal(tickets.reserved,0);
});
test('expired and oversized tickets do not bypass fixed byte budgets',async()=>{
 let now=1;const tickets=new StreamTickets({maxReservedBytes:3,ttlMs:10,now:()=>now});
 await assert.rejects(()=>tickets.open('owner',source(Buffer.from('four'))),/MEDIA_CAPACITY_EXCEEDED/);
 const ticket=await tickets.open('owner',source(Buffer.from('two')));now=12;await assert.rejects(()=>tickets.read('owner',ticket.streamId,0),/WORKER_STREAM_EXPIRED/);await tickets.reap();assert.equal(tickets.reserved,0);
});
