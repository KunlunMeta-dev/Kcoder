import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { completionBadgePng, createTaskbarCompletionBadge } from './taskbar-badge.mjs';

test('badge is a bounded RGBA PNG and caps visible counts at 99+',()=>{
  for(const count of [1,12,99,100,10000]) {
    const png=completionBadgePng(count);
    assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    assert.equal(png.readUInt32BE(16),32);assert.equal(png.readUInt32BE(20),32);
    const data=[];
    for(let offset=8;offset<png.length;) { const size=png.readUInt32BE(offset);const type=png.toString('ascii',offset+4,offset+8);if(type==='IDAT')data.push(png.subarray(offset+8,offset+8+size));offset+=size+12; }
    const pixels=inflateSync(Buffer.concat(data));
    assert.equal(pixels.length,32*(32*4+1));
    assert.equal(pixels[4],0); // transparent corner
    assert.ok(pixels.includes(255));
  }
  assert.deepEqual(completionBadgePng(100),completionBadgePng(10000));
  for(const bad of [-1,0,1.5,10001,NaN,'12'])assert.throws(()=>completionBadgePng(bad));
});

test('Windows badge updates once per count/locale, and reading clears it without focusing a window',()=>{
  const calls=[];let destroyed=false;
  const window={isDestroyed:()=>destroyed,setOverlayIcon:(...args)=>calls.push(args)};
  const badge=createTaskbarCompletionBadge({window,platform:'win32',nativeImage:{createFromBuffer:bytes=>({bytes})}});
  badge.update(12,'zh-CN');badge.update(12,'zh-CN');
  assert.equal(calls.length,1);assert.match(calls[0][1],/12.*待查看/);
  badge.update(12,'en');assert.match(calls[1][1],/12.*review/);
  badge.clear();assert.deepEqual(calls.at(-1),[null,'']);
  destroyed=true;badge.update(2);assert.equal(calls.length,3);
});

test('non-Windows hosts do not invoke Windows-only native methods',()=>{
  const badge=createTaskbarCompletionBadge({window:{isDestroyed:()=>false},platform:'linux'});
  badge.update(1);badge.clear();
});
