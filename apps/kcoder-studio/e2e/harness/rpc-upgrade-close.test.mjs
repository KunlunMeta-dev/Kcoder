import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {openRpc} from './rpc.mjs';
test('an actual peer TCP close before WebSocket upgrade is observed without a false deadline',async()=>{
 const sockets=new Set();let upgradeSeen=false;
 const server=createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.once('data',data=>{upgradeSeen=data.toString('ascii').includes('Upgrade: websocket');socket.destroy()})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const started=Date.now();
 try{await assert.rejects(openRpc('ws://127.0.0.1:'+server.address().port+'/rpc',{timeoutMs:3000}),/closed before the upgrade/);assert.equal(upgradeSeen,true);assert.ok(Date.now()-started<1000)}
 finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve))}
});
