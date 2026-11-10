import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePeerDiagnosticReader } from './native-stderr-diagnostics.mjs';

test('owned receiver diagnostics survive byte fragments and inserted Gateway stderr prefixes',()=>{
 const expected={stage:'original_ui_call',reasonSha256:'8c7c62ffc65035e1ab5bac2a89a26dc39e9361c13a30ea063ca0281564fb9e1c'},records=[];
 const read=nativePeerDiagnosticReader(value=>records.push(value));
 const captured='[app-server] {"event":"native_channel_peer_control_unconfirmed","stage":"original_ui_call","reasonSha256"[app-server] :"'+expected.reasonSha256+'"}\n';
 for(const byte of Buffer.from(captured))read(Buffer.from([byte]));assert.deepEqual(records,[expected]);
 read(Buffer.from('{"event":"native_channel_peer_control_unconfirmed","stage":"original_ui_call","reasonSha256":"PRIVATE_VALUE"}\n'));assert.deepEqual(records,[expected]);
 read(Buffer.from(JSON.stringify({event:'native_channel_peer_control_unconfirmed',...expected,frame:{private:'SYNTHETIC_PRIVATE_VALUE'}})+'\n'));assert.deepEqual(records,[expected,expected]);assert.equal(JSON.stringify(records).includes('SYNTHETIC_PRIVATE_VALUE'),false);
});
