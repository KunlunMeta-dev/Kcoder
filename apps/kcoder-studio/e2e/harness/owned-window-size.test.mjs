import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOwnedWindowSize, parseOwnedPointerDrag } from './ai-verify-gateway.mjs';
test('native resize is bounded to the run display and accepts no executable arguments',()=>{
 assert.deepEqual(parseOwnedWindowSize('400x300'),{width:400,height:300});
 assert.deepEqual(parseOwnedWindowSize('1280x720'),{width:1280,height:720});
 for(const value of ['0x0','400x100','32000x400','1281x900','400;echo x','400x300 --all',null]) assert.throws(()=>parseOwnedWindowSize(value));
});

test('pointer drag only accepts numeric coordinates on the owned display',()=>{
 assert.deepEqual(parseOwnedPointerDrag('400,250:460,250'),[400,250,460,250]);
 for(const value of ['-1,0:2,3','1280,0:1,1','1,2:3,900','1,2:3,4;exec',null]) assert.throws(()=>parseOwnedPointerDrag(value));
});
